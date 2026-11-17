// AffiliateOS — opaque session tokens (P0.5).
//
// The cookie carries a 32-byte random token; the database stores only its
// SHA-256 digest. A leaked `sessions` row therefore cannot be replayed: the
// attacker would need the pre-image, which is not stored anywhere.
//
// Schema notes (verified against prisma/schema.prisma, not assumed):
//   - `token_hash` is BINARY(32), so the digest is a Buffer, not a hex string;
//   - `ip_hash` is BINARY(32) as well, so the client IP is hashed, never stored;
//   - `id` has no database default → a UUID is generated here;
//   - `user_agent` is VARCHAR(255) → truncated before insert;
//   - `revoked_at` exists and is honoured on read.
//
// Every query below is deliberately marked SYSTEM: session handling happens
// before a tenant is known (a user may have no workspace yet), so it is not
// tenant-scoped.

import crypto from "node:crypto";
import { systemDb } from "@affiliateos/database";

export const SESSION_COOKIE_NAME = "session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // SYSTEM: session creation is pre-tenant (the user may have no workspace yet).
  const session = await systemDb().session.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      tokenHash,
      ipHash: hashIp(ip),
      userAgent: userAgent === "" ? null : userAgent.slice(0, 255),
      expiresAt,
    },
    select: { id: true },
  });

  return { token, expiresAt, sessionId: session.id };
}

/**
 * Resolves a cookie token to a live session, or null.
 *
 * Expired rows are deleted on sight (lazy cleanup, TD-7C-A3) and an unknown
 * token, a revoked row and an inactive user all return the same null so the
 * caller cannot tell them apart.
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
      revokedAt: true,
      user: { select: { id: true, email: true, displayName: true, status: true } },
    },
  });

  if (session === null) return null;
  if (session.revokedAt !== null) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    // SYSTEM: expired-session cleanup is not tenant-scoped.
    await systemDb().session.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (session.user.status !== "ACTIVE") return null;

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

/** Cookie attributes for a live session. `secure` only outside development. */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
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
