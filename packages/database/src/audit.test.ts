// Integration tests for writeAudit() (P0.7, T1–T7) against `affiliateos_test`.
//
// The suite rewires DATABASE_URL to TEST_DATABASE_URL before the client is imported
// (the pool opens at module evaluation), and refuses to run if the two point at the
// same database. MIGRATE_DATABASE_URL is deleted in this process only, so the
// runtime separation guard stays intact (TD-7C-A8).
//
// Cleanup is scoped to this suite's own rows (SUITE_MARKER). The other append-only
// suite runs in a parallel process against the same schema, so a blanket deleteMany
// would race with it.
//
// The test database is reached with the migrate credential, which is allowed to
// UPDATE/DELETE; the append-only proof therefore lives in audit-append-only.test.ts,
// where the runtime account is used.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { loadRepoEnv } from "./env.js";

loadRepoEnv();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === "") {
  throw new Error("TEST_DATABASE_URL is required for the audit suite (see .env.example).");
}
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must not be the development database.");
}
process.env.DATABASE_URL = testDatabaseUrl;
delete process.env.MIGRATE_DATABASE_URL;

const { disconnectPrisma } = await import("./client.js");
const { systemDb } = await import("./tenant-db.js");
const { AuditInputError, REDACTED, sanitizeMetadata, writeAudit } = await import("./audit.js");

const TENANT_ID = randomUUID();
const SUITE_MARKER = "suite-audit-writer";

describe("writeAudit()", () => {
  before(async () => {
    // SYSTEM: only this suite's rows, the schema is shared with a parallel suite.
    await systemDb().auditLog.deleteMany({ where: { requestId: SUITE_MARKER } });
  });

  after(async () => {
    // SYSTEM: cleanup of this suite's rows, then a zero-residue assertion.
    await systemDb().auditLog.deleteMany({ where: { requestId: SUITE_MARKER } });
    assert.equal(await systemDb().auditLog.count({ where: { requestId: SUITE_MARKER } }), 0);
    await disconnectPrisma();
  });

  it("T1: tenantId=null → baris tersimpan dengan tenantId null, return id", async () => {
    const id = await writeAudit({
      tenantId: null,
      actorType: "USER",
      actorUserId: randomUUID(),
      action: "auth.login",
      resourceType: "user",
      requestId: SUITE_MARKER,
    });

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    assert.equal(row.tenantId, null);
    assert.equal(row.actorType, "USER");
    assert.equal(row.action, "auth.login");
    assert.equal(row.metadata, null);
    assert.ok(row.createdAt instanceof Date);
  });

  it("T2: tenantId=uuid → baris membawa tenant itu", async () => {
    const id = await writeAudit({
      tenantId: TENANT_ID,
      actorType: "WORKER",
      action: "job.retry",
      resourceType: "job",
      resourceId: randomUUID(),
      requestId: SUITE_MARKER,
    });

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    assert.equal(row.tenantId, TENANT_ID);
    assert.equal(row.actorType, "WORKER");
  });

  it("T3: metadata { password } → [REDACTED] di database", async () => {
    const id = await writeAudit({
      tenantId: null,
      actorType: "USER",
      action: "auth.login_failed",
      resourceType: "user",
      requestId: SUITE_MARKER,
      metadata: { password: "secret-value", reason: "invalid_password" },
    });

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    const metadata = row.metadata as Record<string, unknown>;
    assert.equal(metadata.password, REDACTED);
    assert.equal(metadata.reason, "invalid_password");
    assert.equal(JSON.stringify(metadata).includes("secret-value"), false);
  });

  it("T4: metadata nested { token } → redact di dalam, field aman tetap", async () => {
    const id = await writeAudit({
      tenantId: null,
      actorType: "USER",
      action: "auth.login",
      resourceType: "user",
      requestId: SUITE_MARKER,
      metadata: { nested: { token: "abc", safe: "x" } },
    });

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    const metadata = row.metadata as { nested: Record<string, unknown> };
    assert.equal(metadata.nested.token, REDACTED);
    assert.equal(metadata.nested.safe, "x");
  });

  it("T5: ip 1.2.3.4 → ipHash = SHA-256(1.2.3.4), 32 byte, bukan plaintext", async () => {
    const id = await writeAudit({
      tenantId: null,
      actorType: "USER",
      action: "auth.login",
      resourceType: "user",
      requestId: SUITE_MARKER,
      ip: "1.2.3.4",
    });

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    assert.ok(row.ipHash, "ipHash harus terisi");
    const stored = Buffer.from(row.ipHash);
    const expected = crypto.createHash("sha256").update("1.2.3.4", "utf8").digest();

    assert.equal(stored.length, 32);
    assert.ok(stored.equals(expected), "ipHash harus SHA-256 dari IP");
    // BINARY(32) cannot contain the ASCII address, so this also proves no plaintext.
    assert.equal(stored.toString("utf8").includes("1.2.3.4"), false);
    assert.equal(stored.toString("hex").length, 64);
  });

  it("T6: metadata dengan array bersarang → tidak crash, elemen ikut disanitasi", async () => {
    const id = await writeAudit({
      tenantId: null,
      actorType: "SYSTEM",
      action: "auth.register_bootstrap",
      resourceType: "user",
      requestId: SUITE_MARKER,
      metadata: {
        list: [{ token: "abc", keep: 1 }, "plain", 3, null, [true, { secret: "x" }]],
      },
    });

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    const metadata = row.metadata as { list: unknown[] };
    const [first, second, third, fourth, fifth] = metadata.list as [
      Record<string, unknown>,
      string,
      number,
      null,
      [boolean, Record<string, unknown>],
    ];

    assert.equal(first.token, REDACTED);
    assert.equal(first.keep, 1);
    assert.equal(second, "plain");
    assert.equal(third, 3);
    assert.equal(fourth, null);
    assert.equal(fifth[0], true);
    assert.equal(fifth[1].secret, REDACTED);
  });

  it("T7: tanpa metadata → metadata null", async () => {
    const id = await writeAudit({
      tenantId: null,
      actorType: "USER",
      action: "auth.logout",
      resourceType: "user",
      requestId: SUITE_MARKER,
    });

    const row = await systemDb().auditLog.findUniqueOrThrow({ where: { id } });
    assert.equal(row.metadata, null);
  });

  it("menolak action yang tidak berformat domain.verb atau terlalu panjang", async () => {
    await assert.rejects(
      writeAudit({ tenantId: null, actorType: "USER", action: "login", resourceType: "user" }),
      AuditInputError,
    );
    await assert.rejects(
      writeAudit({
        tenantId: null,
        actorType: "USER",
        action: `auth.${"x".repeat(80)}`,
        resourceType: "user",
      }),
      AuditInputError,
    );
  });

  it("sanitasi rekursif menangani kunci sensitif multi-kata", () => {
    const sanitized = sanitizeMetadata({
      apiKey: "a",
      api_key: "b",
      Authorization: "Bearer x",
      csrfToken: "c",
      nested: { refresh_token: "d", note: "ok" },
    }) as Record<string, Record<string, unknown> | string>;

    assert.equal(sanitized.apiKey, REDACTED);
    assert.equal(sanitized.api_key, REDACTED);
    assert.equal(sanitized.Authorization, REDACTED);
    assert.equal(sanitized.csrfToken, REDACTED);
    assert.deepEqual(sanitized.nested, { refresh_token: REDACTED, note: "ok" });
  });
});
