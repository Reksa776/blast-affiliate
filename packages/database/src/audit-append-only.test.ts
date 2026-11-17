// Append-only enforcement for audit_logs (P0.7) — two independent layers, both
// proven against a real database.
//
// Layer 1, application: `withTenant(ctx)` refuses update/updateMany/upsert/delete/
// deleteMany on AuditLog before a query is built. Checked on the test schema.
//
// Layer 2, database grant: the runtime account (`affiliateos_app`) holds only
// SELECT and INSERT on `audit_logs`. Verified with `SHOW GRANTS`; UPDATE/DELETE
// fail with 1142.
//
// Why layer 2 cannot run on `affiliateos_test`: that schema is reached with the DDL
// account (TD-7C-A8, TD-7D-R2), which is allowed to UPDATE/DELETE, and the DDL
// account has no GRANT OPTION (verified: `GRANT ... TO affiliateos_app` returns
// ER_TABLEACCESS_DENIED_ERROR 1142). The grant therefore exists only on the runtime
// schema, so layer 2 opens a second client with the RUNTIME credential.
//
// How the probe stays non-mutating:
//   - `update`/`delete` by unique id: Prisma reads the row first and reports P2025
//     ("no record") when it is absent, so a nil UUID never reaches UPDATE. The probe
//     therefore inserts a row and attempts the mutation INSIDE one interactive
//     transaction that is rolled back — the mutation is issued, denied with 1142,
//     and no row survives.
//   - `updateMany`/`deleteMany`: attempted on a nil UUID, which affects zero rows
//     even if it were allowed.
//   - INSERT: proven by the rolled-back transaction above plus T8.
//   - SELECT: read-only.
//
// So no durable write and no read of another tenant's row: this is a privilege
// probe, not a data integration test.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { loadRepoEnv } from "./env.js";

loadRepoEnv();

const runtimeUrl = process.env.DATABASE_URL;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (runtimeUrl === undefined || runtimeUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the append-only grant probe.");
}
if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === "") {
  throw new Error("TEST_DATABASE_URL is required for the append-only suite.");
}
if (testDatabaseUrl === runtimeUrl) {
  throw new Error("TEST_DATABASE_URL must not be the development database.");
}

// Layer 1 runs on the test schema.
process.env.DATABASE_URL = testDatabaseUrl;
delete process.env.MIGRATE_DATABASE_URL;

const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
const { disconnectPrisma } = await import("./client.js");
const { PrismaClient } = await import("./generated/prisma/client.js");
const { accountKey, buildPoolOptions } = await import("./pool.js");
const { createTenantContext } = await import("./tenancy.js");
const { systemDb, TenantAppendOnlyError, withTenant } = await import("./tenant-db.js");

const TENANT_ID = randomUUID();
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DENIED = /denied|1142|ER_TABLEACCESS_DENIED/i;

let runtimeDb: InstanceType<typeof PrismaClient>;
let runtimeAdapter: InstanceType<typeof PrismaMariaDb>;

const ctx = createTenantContext({
  tenantId: TENANT_ID,
  userId: randomUUID(),
  membershipId: randomUUID(),
  actorType: "user",
  requestId: "req-audit-append-only",
  permissions: ["audit.read"],
});

function denialText(error: unknown): string {
  const meta = (error as { meta?: unknown }).meta ?? {};
  return `${(error as Error).message ?? ""} ${JSON.stringify(meta)}`;
}

describe("audit_logs append-only — lapisan aplikasi (withTenant)", () => {
  before(async () => {
    assert.notEqual(
      accountKey(runtimeUrl),
      accountKey(testDatabaseUrl),
      "runtime dan test harus memakai akun berbeda untuk probe grant",
    );

    runtimeAdapter = new PrismaMariaDb(buildPoolOptions(runtimeUrl));
    runtimeDb = new PrismaClient({ adapter: runtimeAdapter });

    // SYSTEM: the test schema is cleaned by this suite before and after.
    await systemDb().auditLog.deleteMany({ where: { tenantId: TENANT_ID } });
  });

  after(async () => {
    // SYSTEM: cleanup of this suite's rows on the test schema.
    await systemDb().auditLog.deleteMany({ where: { tenantId: TENANT_ID } });
    assert.equal(await systemDb().auditLog.count({ where: { tenantId: TENANT_ID } }), 0);

    await runtimeDb.$disconnect();
    // `$disconnect` does not always close a driver-adapter pool, and an open pool
    // keeps the test process alive; close whichever handle the adapter exposes.
    const disposable = runtimeAdapter as unknown as {
      dispose?: () => Promise<void>;
      end?: () => Promise<void>;
    };
    await disposable.dispose?.();
    await disposable.end?.();

    await disconnectPrisma();
  });

  it("T1: update() lewat withTenant ditolak sebelum menyentuh database", async () => {
    await assert.rejects(
      withTenant(ctx, (db) => db.auditLog.update({ where: { id: NIL_UUID }, data: { userAgent: "x" } })),
      (error: unknown) => {
        assert.ok(error instanceof TenantAppendOnlyError);
        assert.match(error.message, /append-only: update/);
        return true;
      },
    );
  });

  it("T2: delete/deleteMany/updateMany/upsert juga ditolak", async () => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["delete", () => withTenant(ctx, (db) => db.auditLog.delete({ where: { id: NIL_UUID } }))],
      ["deleteMany", () => withTenant(ctx, (db) => db.auditLog.deleteMany({ where: { id: NIL_UUID } }))],
      [
        "updateMany",
        () => withTenant(ctx, (db) => db.auditLog.updateMany({ where: { id: NIL_UUID }, data: { userAgent: "x" } })),
      ],
      [
        "upsert",
        () =>
          withTenant(ctx, (db) =>
            db.auditLog.upsert({
              where: { id: NIL_UUID },
              create: {
                id: NIL_UUID,
                tenantId: TENANT_ID,
                actorType: "SYSTEM",
                action: "probe.upsert",
                resourceType: "probe",
              },
              update: { userAgent: "x" },
            }),
          ),
      ],
    ];

    for (const [operation, attempt] of attempts) {
      await assert.rejects(attempt, TenantAppendOnlyError, `${operation} harus ditolak`);
    }
  });

  it("T3: findMany() tetap boleh (audit harus bisa dibaca)", async () => {
    const rows = await withTenant(ctx, (db) => db.auditLog.findMany({ take: 1 }));
    assert.ok(Array.isArray(rows));
  });

  it("T4: create() tetap boleh dan barisnya hanya milik tenant konteks", async () => {
    const id = randomUUID();
    await withTenant(ctx, (db) =>
      db.auditLog.create({
        data: {
          id,
          tenantId: TENANT_ID,
          actorType: "SYSTEM",
          action: "probe.create",
          resourceType: "probe",
        },
      }),
    );

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    assert.equal(row.tenantId, TENANT_ID);
  });
});

describe("audit_logs append-only — lapisan grant (akun runtime)", () => {
  it("T5: update() pada baris yang ada ditolak grant 1142 (transaksi di-rollback)", async () => {
    const id = randomUUID();

    await assert.rejects(
      // SYSTEM probe: INSERT (allowed) lalu UPDATE (denied) dalam satu transaksi.
      runtimeDb.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: {
            id,
            tenantId: null,
            actorType: "SYSTEM",
            action: "probe.update",
            resourceType: "probe",
          },
        });
        await tx.auditLog.update({ where: { id }, data: { userAgent: "probe" } });
      }),
      (error: unknown) => {
        assert.match(denialText(error), DENIED);
        return true;
      },
    );

    assert.equal(await runtimeDb.auditLog.findUnique({ where: { id } }), null, "baris probe tidak boleh tersisa");
  });

  it("T6: delete() pada baris yang ada ditolak grant 1142 (transaksi di-rollback)", async () => {
    const id = randomUUID();

    await assert.rejects(
      runtimeDb.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: {
            id,
            tenantId: null,
            actorType: "SYSTEM",
            action: "probe.delete",
            resourceType: "probe",
          },
        });
        await tx.auditLog.delete({ where: { id } });
      }),
      (error: unknown) => {
        assert.match(denialText(error), DENIED);
        return true;
      },
    );

    assert.equal(await runtimeDb.auditLog.findUnique({ where: { id } }), null, "baris probe tidak boleh tersisa");
  });

  it("T7: updateMany()/deleteMany() ditolak grant 1142 tanpa menyentuh baris", async () => {
    await assert.rejects(
      runtimeDb.auditLog.updateMany({ where: { id: NIL_UUID }, data: { userAgent: "probe" } }),
      DENIED,
      "updateMany harus ditolak grant",
    );
    await assert.rejects(
      runtimeDb.auditLog.deleteMany({ where: { id: NIL_UUID } }),
      DENIED,
      "deleteMany harus ditolak grant",
    );
  });

  it("T8: findMany() diizinkan (SELECT)", async () => {
    const rows = await runtimeDb.auditLog.findMany({ take: 1 });
    assert.ok(Array.isArray(rows));
  });

  it("T9: create() diizinkan (INSERT) dan rollback tidak meninggalkan baris", async () => {
    const id = randomUUID();

    await assert.rejects(
      runtimeDb.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: {
            id,
            tenantId: null,
            actorType: "SYSTEM",
            action: "probe.insert",
            resourceType: "probe",
          },
        });
        throw new Error("rollback-probe");
      }),
      /rollback-probe/,
    );

    assert.equal(await runtimeDb.auditLog.findUnique({ where: { id } }), null, "baris probe tidak boleh tersisa");
  });
});
