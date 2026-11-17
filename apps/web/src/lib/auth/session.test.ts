// Session tests against the REAL database (P0.5 policy, hardened in P1 8C).
//
// Covers the policy the audit found missing: a 7-day absolute lifetime, a 24-hour
// idle timeout, the throttled `last_seen_at` refresh, rotation, and the `__Host-`
// cookie name. Time is moved by editing the row, never by sleeping and never by
// mocking the clock: the assertions run against MariaDB exactly as production will.
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

const {
  IDLE_TIMEOUT_MS,
  IDLE_UPDATE_THRESHOLD_MS,
  SESSION_TTL_MS,
  clearedSessionCookieOptions,
  createSession,
  destroySession,
  generateSessionToken,
  hashToken,
  revokeAllSessionsForUser,
  rotateSession,
  sessionCookieOptions,
  validateSession,
} = await import("./session.ts");
const { getSessionCookieName } = await import("./cookie-name.ts");
const { disconnectPrisma, systemDb } = await import("@affiliateos/database");

const userId = randomUUID();
const email = `session-test-${userId}@test.local`;

async function lastSeenAtOf(token: string): Promise<Date> {
  const row = await systemDb().session.findUniqueOrThrow({
    where: { tokenHash: hashToken(token) },
    select: { lastSeenAt: true },
  });
  return row.lastSeenAt;
}

async function ageSession(token: string, ageMs: number): Promise<void> {
  await systemDb().session.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { lastSeenAt: new Date(Date.now() - ageMs) },
  });
}

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
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");

    const session = await validateSession(token);
    assert.ok(session, "session harus valid");
    assert.equal(session.userId, userId);
    assert.equal(session.user.email, email);
    assert.equal(session.user.displayName, "Session Test");
    assert.equal(session.activeTenantId, null);

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

describe("session policy (8C)", () => {
  it("T1: createSession menyetel lastSeenAt ≈ sekarang dan expiresAt = +7 hari", async () => {
    const before = Date.now();
    const { token, expiresAt } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    const afterCreate = Date.now();

    const lastSeenAt = await lastSeenAtOf(token);
    assert.ok(
      lastSeenAt.getTime() >= before - 1_000 && lastSeenAt.getTime() <= afterCreate + 1_000,
      `lastSeenAt harus waktu pembuatan, dapat ${lastSeenAt.toISOString()}`,
    );

    const expected = before + SESSION_TTL_MS;
    assert.ok(
      Math.abs(expiresAt.getTime() - expected) < 5_000,
      `expiresAt harus +7 hari dari pembuatan, dapat ${expiresAt.toISOString()}`,
    );

    const stored = await systemDb().session.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
      select: { expiresAt: true },
    });
    assert.equal(stored.expiresAt.getTime(), expiresAt.getTime());

    await destroySession(token);
  });

  it("T2: sesi valid dengan lastSeenAt > 1 jam → lastSeenAt diperbarui", async () => {
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    await ageSession(token, 2 * 60 * 60 * 1000);

    const stale = await lastSeenAtOf(token);
    const session = await validateSession(token);
    assert.ok(session, "sesi 2 jam masih di bawah idle timeout");
    assert.equal(session.userId, userId);

    const refreshed = await lastSeenAtOf(token);
    assert.ok(refreshed.getTime() > stale.getTime(), "lastSeenAt harus maju");
    assert.ok(Date.now() - refreshed.getTime() < 5_000, "lastSeenAt harus ≈ sekarang");

    await destroySession(token);
  });

  it("T3: idle 25 jam → null dan barisnya dihapus", async () => {
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    await ageSession(token, 25 * 60 * 60 * 1000);

    assert.equal(await validateSession(token), null);
    assert.equal(
      await systemDb().session.count({ where: { tokenHash: hashToken(token) } }),
      0,
      "sesi idle harus dihapus",
    );
  });

  it("T4: absolute expiry lewat (lastSeenAt baru) → null dan barisnya dihapus", async () => {
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    // Fresh lastSeenAt, expired absolute lifetime: only the TTL check can reject it.
    await systemDb().session.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    assert.equal(await validateSession(token), null);
    assert.equal(
      await systemDb().session.count({ where: { tokenHash: hashToken(token) } }),
      0,
      "sesi expired harus dihapus",
    );
  });

  it("T5: revokedAt terisi → null, baris dipertahankan untuk audit", async () => {
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    await systemDb().session.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { revokedAt: new Date() },
    });

    assert.equal(await validateSession(token), null);
    assert.equal(
      await systemDb().session.count({ where: { tokenHash: hashToken(token) } }),
      1,
      "baris yang di-revoke tidak dihapus",
    );
  });

  it("T6: lastSeenAt 30 menit → tidak diperbarui (throttle 1 jam)", async () => {
    const { token } = await createSession(userId, "127.0.0.1", "node-test/1.0");
    await ageSession(token, 30 * 60 * 1000);

    const stale = await lastSeenAtOf(token);
    assert.ok(await validateSession(token));
    const after = await lastSeenAtOf(token);

    assert.equal(after.getTime(), stale.getTime(), "di bawah ambang 1 jam: tidak ada write");

    await destroySession(token);
  });

  it("T7: rotateSession → token lama revoked, token baru valid", async () => {
    const { token: oldToken } = await createSession(userId, "127.0.0.1", "node-test/1.0");

    const rotated = await rotateSession(oldToken, userId, "127.0.0.1", "node-test/1.0");
    assert.notEqual(rotated.token, oldToken);

    assert.equal(await validateSession(oldToken), null, "token lama tidak boleh berlaku");

    const oldRow = await systemDb().session.findUnique({
      where: { tokenHash: hashToken(oldToken) },
      select: { revokedAt: true },
    });
    assert.ok(oldRow, "baris lama dipertahankan");
    assert.ok(oldRow.revokedAt, "baris lama harus revoked, bukan dihapus");

    const fresh = await validateSession(rotated.token);
    assert.ok(fresh, "token baru harus valid");
    assert.equal(fresh.userId, userId);

    await destroySession(rotated.token);
  });

  it("T8: revokeAllSessionsForUser → semua sesi user revoked", async () => {
    const first = await createSession(userId, "127.0.0.1", "node-test/1.0");
    const second = await createSession(userId, "127.0.0.1", "node-test/2.0");

    await revokeAllSessionsForUser(userId);

    assert.equal(await validateSession(first.token), null);
    assert.equal(await validateSession(second.token), null);

    const rows = await systemDb().session.findMany({
      where: { userId },
      select: { revokedAt: true },
    });
    assert.ok(rows.length >= 2);
    assert.equal(rows.every((row) => row.revokedAt !== null), true);
  });

  it("cookie name: __Host- di production, plain di dev", () => {
    // Next types `NODE_ENV` as read-only; the test needs to flip it, so it goes
    // through a mutable view instead of a cast per assignment.
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    try {
      env.NODE_ENV = "production";
      assert.equal(getSessionCookieName(), "__Host-aos_session");

      env.NODE_ENV = "development";
      assert.equal(getSessionCookieName(), "aos_session");

      env.NODE_ENV = undefined;
      assert.equal(getSessionCookieName(), "aos_session");
    } finally {
      env.NODE_ENV = original;
    }
  });

  it("cookie attributes: Max-Age 604800, Secure hanya production, tanpa Domain", () => {
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    try {
      env.NODE_ENV = "production";
      const secure = sessionCookieOptions(new Date());
      assert.equal(secure.httpOnly, true);
      assert.equal(secure.secure, true);
      assert.equal(secure.sameSite, "lax");
      assert.equal(secure.path, "/");
      assert.equal(secure.maxAge, 604_800);
      assert.equal("domain" in secure, false, "__Host- melarang Domain");

      const clearedSecure = clearedSessionCookieOptions();
      assert.equal(clearedSecure.maxAge, 0);
      assert.equal("domain" in clearedSecure, false);

      env.NODE_ENV = "development";
      assert.equal(sessionCookieOptions(new Date()).secure, false, "dev berjalan di http");
    } finally {
      env.NODE_ENV = original;
    }
  });

  it("konstanta: TTL 7 hari, idle 24 jam, ambang refresh 1 jam", () => {
    assert.equal(SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(IDLE_TIMEOUT_MS, 24 * 60 * 60 * 1000);
    assert.equal(IDLE_UPDATE_THRESHOLD_MS, 60 * 60 * 1000);
  });
});
