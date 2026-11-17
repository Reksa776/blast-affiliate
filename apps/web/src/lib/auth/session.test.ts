// Session tests against the REAL database (P0.5).
//
// The Prisma client reads DATABASE_URL at module-evaluation time, so the
// environment is loaded first and `session.ts` is imported dynamically.
//
// Isolation: a dedicated user row is created in `before` and removed in `after`,
// which then asserts that no session row survives.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { loadEnvForTests } from "./test-env.ts";

loadEnvForTests();

const { createSession, destroySession, generateSessionToken, hashToken, validateSession } = await import(
  "./session.ts"
);
const { disconnectPrisma, systemDb } = await import("@affiliateos/database");

const userId = randomUUID();
const email = `session-test-${userId}@test.local`;

before(async () => {
  await systemDb().user.create({
    data: {
      id: userId,
      email,
      displayName: "Session Test",
      // The session code never reads the hash; a fixed encoded string is enough.
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    },
  });
});

after(async () => {
  await systemDb().session.deleteMany({ where: { userId } });
  await systemDb().user.deleteMany({ where: { id: userId } });

  assert.equal(await systemDb().session.count({ where: { userId } }), 0);
  await disconnectPrisma();
});

describe("session lifecycle", () => {
  it("createSession → validateSession mengembalikan sesi milik user itu", async () => {
    const { token, expiresAt } = await createSession(userId, "127.0.0.1", "node-test/1.0");

    const session = await validateSession(token);
    assert.ok(session, "session harus valid");
    assert.equal(session.userId, userId);
    assert.equal(session.user.email, email);
    assert.equal(session.user.displayName, "Session Test");
    assert.equal(session.activeTenantId, null);
    assert.ok(session.expiresAt.getTime() > Date.now());
    assert.ok(expiresAt.getTime() > Date.now());

    await destroySession(token);
  });

  it("token salah → null", async () => {
    assert.equal(await validateSession(generateSessionToken()), null);
    assert.equal(await validateSession(""), null);
  });

  it("sesi expired → null dan barisnya dihapus", async () => {
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    const tokenHash = hashToken(token);

    await systemDb().session.updateMany({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    assert.equal(await validateSession(token), null);
    assert.equal(
      await systemDb().session.count({ where: { tokenHash } }),
      0,
      "baris sesi expired harus terhapus",
    );
  });

  it("destroySession → token tidak berlaku lagi dan barisnya hilang", async () => {
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    assert.ok(await validateSession(token));

    await destroySession(token);

    assert.equal(await validateSession(token), null);
    assert.equal(await systemDb().session.count({ where: { tokenHash: hashToken(token) } }), 0);
  });

  it("token 43 karakter base64url, hash SHA-256 32 byte, dan selalu unik", async () => {
    const token = generateSessionToken();
    const other = generateSessionToken();

    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(token, other);

    const digest = hashToken(token);
    assert.equal(digest instanceof Uint8Array, true);
    assert.equal(digest.length, 32);
    assert.notEqual(Buffer.from(digest).toString("hex"), token);
  });
});
