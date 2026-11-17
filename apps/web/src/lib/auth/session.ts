// AffiliateOS — opaque session tokens (P0.5, policy hardened in P1 8C).
//
// The cookie carries a 32-byte random token; the database stores only its
// SHA-256 digest. A leaked `sessions` row therefore cannot be replayed: the
// attacker would need the pre-image, which is not stored anywhere.
//
// Session policy (docs/04 §3.4):
//   - absolute lifetime 7 days (`SESSION_TTL_MS`), fixed at creation;
//   - idle timeout 24 hours, measured from `last_seen_at`;
//   - `last_seen_at` is refreshed at most once per hour per session, so a busy
//     client costs one write an hour instead of one write per request;
//   - rotation on privilege change (`rotateSession`, `revokeAllSessionsForUser`).
//
// Schema notes (verified against prisma/schema.prisma, not assumed):
//   - `token_hash` is BINARY(32), so the digest is a Buffer, not a hex string;
//   - `ip_hash` is BINARY(32) as well, so the client IP is hashed, never stored;
//   - `last_seen_at` is DATETIME(3) NOT NULL with a `now()` default;
//   - `id` has no database default → a UUID is generated here;
//   - `user_agent` is VARCHAR(255) → truncated before insert;
//   - `revoked_at` exists and is honoured on read.
//
// Every query below is deliberately marked SYSTEM: session handling happens
// before a tenant is known (a user may have no workspace yet), so it is not
// tenant-scoped.

import crypto from "node:crypto";
import { systemDb } from "@affiliateos/database";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, absolute
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000; // 604800, for Max-Age
export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours of inactivity
export const IDLE_UPDATE_THRESHOLD_MS = 60 * 60 * 1000; // refresh at most hourly
export const SESSION_TOKEN_BYTES = 32;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
};

export type ValidatedSession = {
  id: string;
  userId: string;
  activeTenantId: string | null;
  expiresAt: Date;
  user: SessionUser;
};

/** 32 random bytes → 43 base64url characters. */
export function generateSessionToken(): string {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 as raw bytes.
 *
 * Prisma 7 types a `Bytes` column as `Uint8Array<ArrayBuffer>`, while Node's
 * `Buffer` is backed by `ArrayBufferLike` (it may be a SharedArrayBuffer view), so
 * the digest is copied into a fresh view. Copying 32 bytes is free next to a query.
 */
function sha256Bytes(value: string): Uint8Array<ArrayBuffer> {
  const digest = crypto.createHash("sha256").update(value, "utf8").digest();
  return new Uint8Array(digest);
}

/** SHA-256 of the token, as the raw 32 bytes the column expects. */
export function hashToken(token: string): Uint8Array<ArrayBuffer> {
  return sha256Bytes(token);
}

function hashIp(ip: string): Uint8Array<ArrayBuffer> {
  return sha256Bytes(ip);
}

/**
 * Persists a new session and returns the plain token, which is the only moment it
 * exists outside the cookie. Callers must never log the returned value.
 */
export async function createSession(
  userId: string,
  ip: string,
  userAgent: string,
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  // SYSTEM: session creation is pre-tenant (the user may have no workspace yet).
  const session = await systemDb().session.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      tokenHash,
      ipHash: hashIp(ip),
      userAgent: userAgent === "" ? null : userAgent.slice(0, 255),
      expiresAt,
      // Explicit even though the column defaults to now(): the idle window starts
      // at creation, and a future schema default change must not move it.
      lastSeenAt: now,
    },
    select: { id: true },
  });

  return { token, expiresAt, sessionId: session.id };
}

/**
 * Resolves a cookie token to a live session, or null.
 *
 * Rejected sessions: unknown token, revoked row, past the absolute expiry, idle for
 * more than 24 hours, or owned by a user that is no longer ACTIVE. Expired and idle
 * rows are deleted on sight (lazy cleanup, TD-7C-A3); a revoked row is kept so the
 * revocation itself stays auditable. Every rejection returns the same null so the
 * caller cannot tell them apart.
 *
 * A live session has its `last_seen_at` refreshed, but only when the stored value is
 * older than an hour: that keeps the idle window accurate without turning every
 * authenticated request into a write.
 */
export async function validateSession(token: string): Promise<ValidatedSession | null> {
  if (typeof token !== "string" || token === "") return null;

  // SYSTEM: session lookup is pre-tenant.
  const session = await systemDb().session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      activeTenantId: true,
      expiresAt: true,
      lastSeenAt: true,
      revokedAt: true,
      user: { select: { id: true, email: true, displayName: true, status: true } },
    },
  });

  if (session === null) return null;
  if (session.revokedAt !== null) return null;

  const now = Date.now();
  const lastSeen = session.lastSeenAt.getTime();

  if (session.expiresAt.getTime() <= now) {
    // SYSTEM: expired-session cleanup is not tenant-scoped.
    await systemDb().session.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (now - lastSeen > IDLE_TIMEOUT_MS) {
    // SYSTEM: idle-session cleanup is not tenant-scoped.
    await systemDb().session.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (session.user.status !== "ACTIVE") return null;

  if (now - lastSeen > IDLE_UPDATE_THRESHOLD_MS) {
    // SYSTEM: last-seen refresh is not tenant-scoped. `updateMany` keeps a session
    // that was concurrently revoked from throwing: the where clause simply misses.
    await systemDb().session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { lastSeenAt: new Date(now) },
    });
  }

  return {
    id: session.id,
    userId: session.userId,
    activeTenantId: session.activeTenantId,
    expiresAt: session.expiresAt,
    user: {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
    },
  };
}

/** Deletes the session row for a token. Unknown tokens are a no-op. */
export async function destroySession(token: string): Promise<void> {
  if (typeof token !== "string" || token === "") return;

  // SYSTEM: session destruction is pre-tenant.
  await systemDb().session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/**
 * Rotation: revoke the presented session and issue a fresh one for the same user.
 *
 * Used when the caller's own privileges change (workspace created, invitation
 * accepted). The old row is kept with `revoked_at` set — a rotation is a security
 * event and stays visible in the table — while the new token is returned so the
 * route can replace the cookie in the same response.
 */
export async function rotateSession(
  oldToken: string,
  userId: string,
  ip: string,
  userAgent: string,
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  if (typeof oldToken === "string" && oldToken !== "") {
    // SYSTEM: session rotation revokes the old token before a new one exists.
    await systemDb().session.updateMany({
      where: { tokenHash: hashToken(oldToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return createSession(userId, ip, userAgent);
}

/**
 * Revokes every live session of a user.
 *
 * Used when *another* actor changes the user's privileges (role change): their
 * existing cookies must stop carrying the old authority, and the only safe shape is
 * to require a fresh login. Sessions are revoked, not deleted, so the trail shows
 * why the user was signed out.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  // SYSTEM: privilege-change revocation is not tenant-scoped.
  await systemDb().session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Cookie attributes for a live session.
 *
 * No `Domain` key is ever set: that is required for the `__Host-` prefix and also
 * correct without it. `maxAge` matches the absolute TTL; `expires` is kept for
 * clients that ignore `Max-Age`.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    expires: expiresAt,
  };
}

/** Cookie attributes that clear the session cookie. */
export function clearedSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}
