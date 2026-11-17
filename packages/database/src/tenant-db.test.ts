// Integration tests for withTenant() / systemDb() against the REAL database
// (Checkpoint 7B, Task C). No mocks and no SQLite: every query below goes to
// MariaDB through the runtime account, which is DML-only by grant, so a mistake
// in the scoping rules shows up as a real result, not a simulated one.
//
// Isolation note: the mutation tests (T2–T5) assert that a write is REFUSED, and
// T1/T6/T7 only read. The fixtures created in `before` are removed in `after`,
// which then asserts the rows are gone. Prisma 7 does not expose `$extends` on an
// interactive-transaction client, so a scoped query cannot participate in a
// BEGIN/ROLLBACK wrapper; cleanup + zero-residue assertion is the compensating
// control (see docs/PHASE-1-CHECKPOINT-7B-TASKC.md).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { loadRepoEnv } from "./env.js";
import type { TenantContext } from "./tenancy.js";

// The Prisma client opens its pool at module-evaluation time, so the environment
// must exist before `tenant-db.js` is imported. Static imports are hoisted; the
// dynamic imports below are not.
if (!process.env.DATABASE_URL) {
  loadRepoEnv();
}

const { disconnectPrisma } = await import("./client.js");
const { createTenantContext, TenantContextError } = await import("./tenancy.js");
const { systemDb, withTenant, TenantModelAccessError, TenantWriteScopeError } = await import(
  "./tenant-db.js"
);

type RoleRow = { id: string; tenantId: string; name: string };

const tenantA = randomUUID();
const tenantB = randomUUID();
const userId = randomUUID();
const membershipId = randomUUID();

let ctxA: TenantContext;
let ctxB: TenantContext;
let roleA: RoleRow;
let roleB: RoleRow;

describe("withTenant() / systemDb()", () => {
  before(async () => {
    const db = systemDb();

    await db.workspace.createMany({
      data: [
        { id: tenantA, slug: `taskc-a-${tenantA.slice(0, 8)}`, name: "Task C workspace A" },
        { id: tenantB, slug: `taskc-b-${tenantB.slice(0, 8)}`, name: "Task C workspace B" },
      ],
    });

    roleA = await db.role.create({
      data: { id: randomUUID(), tenantId: tenantA, key: "WORKSPACE_OWNER", name: "Owner A" },
    });
    roleB = await db.role.create({
      data: { id: randomUUID(), tenantId: tenantB, key: "WORKSPACE_OWNER", name: "Owner B" },
    });

    ctxA = createTenantContext({
      tenantId: tenantA,
      userId,
      membershipId,
      actorType: "user",
      requestId: "req-task-c-a",
      permissions: ["role.read"],
    });
    ctxB = createTenantContext({
      tenantId: tenantB,
      userId,
      membershipId,
      actorType: "user",
      requestId: "req-task-c-b",
      permissions: ["role.read"],
    });
  });

  after(async () => {
    const db = systemDb();
    const tenants = [tenantA, tenantB];

    // Explicit role delete first: the workspace FK is ON DELETE CASCADE, but the
    // test must not rely on the cascade it is not asserting.
    await db.role.deleteMany({ where: { tenantId: { in: tenants } } });
    await db.workspace.deleteMany({ where: { id: { in: tenants } } });

    assert.equal(await db.role.count({ where: { tenantId: { in: tenants } } }), 0);
    assert.equal(await db.workspace.count({ where: { id: { in: tenants } } }), 0);

    await disconnectPrisma();
  });

  it("T1: findMany returns only the rows of the context tenant", async () => {
    const rows = await withTenant(ctxA, (db) => db.role.findMany());

    assert.equal(rows.length, 1, "tenant A must see exactly its own role");
    assert.equal(rows[0]?.id, roleA.id);
    assert.equal(rows[0]?.tenantId, tenantA);
    assert.equal(
      rows.some((row) => row.id === roleB.id),
      false,
      "tenant B's role must never appear in tenant A's result",
    );
  });

  it("T2: update of another tenant's row is refused and changes nothing", async () => {
    await assert.rejects(
      withTenant(ctxA, (db) => db.role.update({ where: { id: roleB.id }, data: { name: "hacked" } })),
      (error: unknown) => (error as { code?: string }).code === "P2025",
    );

    const after = await systemDb().role.findUniqueOrThrow({ where: { id: roleB.id } });
    assert.equal(after.name, "Owner B", "tenant B's role name must be untouched");
  });

  it("T3: delete of another tenant's row is refused and the row survives", async () => {
    await assert.rejects(
      withTenant(ctxA, (db) => db.role.delete({ where: { id: roleB.id } })),
      (error: unknown) => (error as { code?: string }).code === "P2025",
    );

    const stillThere = await systemDb().role.findUnique({ where: { id: roleB.id } });
    assert.ok(stillThere, "tenant B's role must still exist");
    assert.equal(stillThere.tenantId, tenantB);
  });

  it("T4: create without a tenantId is refused before it reaches the database", async () => {
    const data = { id: randomUUID(), key: "VIEWER", name: "no tenant" };

    await assert.rejects(
      withTenant(ctxA, (db) => db.role.create({ data } as never)),
      (error: unknown) => {
        assert.ok(error instanceof TenantWriteScopeError);
        assert.match(error.message, /missing tenantId/);
        return true;
      },
    );
  });

  it("T5: create naming another tenant is refused", async () => {
    await assert.rejects(
      withTenant(ctxA, (db) =>
        db.role.create({
          data: { id: randomUUID(), tenantId: tenantB, key: "VIEWER", name: "wrong tenant" },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof TenantWriteScopeError);
        assert.match(error.message, /does not match the tenant context/);
        return true;
      },
    );

    const leaked = await systemDb().role.count({ where: { tenantId: tenantB } });
    assert.equal(leaked, 1, "only the fixture role may exist for tenant B");
  });

  it("T6: systemDb() is unscoped and sees both tenants", async () => {
    const rows = await systemDb().role.findMany({
      where: { id: { in: [roleA.id, roleB.id] } },
      orderBy: { id: "asc" },
    });

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.tenantId).sort(),
      [tenantA, tenantB].sort(),
    );
    assert.equal(await withTenant(ctxB, (db) => db.role.count()), 1);
  });

  it("T7: a forged context is rejected before any query", async () => {
    const forged = { tenantId: "" } as unknown as TenantContext;

    await assert.rejects(
      withTenant(forged, async () => "unreachable"),
      TenantContextError,
    );
  });

  it("T8: a platform model is refused with a named error", async () => {
    await assert.rejects(
      withTenant(ctxA, (db) => (db as unknown as { user: { findMany: () => Promise<unknown> } }).user.findMany()),
      (error: unknown) => {
        assert.ok(error instanceof TenantModelAccessError);
        assert.equal(error.message, "Model User is not tenant-scoped.");
        return true;
      },
    );
  });
});
