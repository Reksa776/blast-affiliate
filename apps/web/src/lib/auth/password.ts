// AffiliateOS — password hashing (P0.5).
//
// Argon2id only, with the OWASP Password Storage Cheat Sheet baseline for the
// "19 MiB / t=2 / p=1" configuration. Never bcrypt, never a fast hash: an
// attacker who reads the `users` table must pay ~19 MiB and two passes per guess.
//
// The encoded string carries its own salt and parameters, so a future cost bump
// does not invalidate existing hashes (`argon2.verify` reads them from the hash).
// Passwords are never logged, never echoed in errors, and never stored in plain
// text by this module or its callers.

import argon2 from "argon2";

/** OWASP baseline: 19 MiB, 2 iterations, no parallelism. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Minimum accepted length. Enforced here so no caller can bypass it. */
export const PASSWORD_MIN_LENGTH = 12;

/** Hash a plain-text password. Throws (without echoing the value) when too short. */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Verify a password against an encoded Argon2id string.
 *
 * Returns false on a malformed or unreadable hash instead of throwing: a corrupt
 * row must fail the login, not 500 the endpoint, and the caller must not be able
 * to distinguish "bad hash" from "bad password".
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
