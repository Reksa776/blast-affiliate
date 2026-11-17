// Unit tests for Argon2id password hashing (P0.5).
// No database, no network: the hash string is self-contained.

import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "./password.ts";

const PASSWORD = "SuperSecret12345"; // 17 chars

test("hash lalu verify dengan password benar → true", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(hash, PASSWORD), true);
});

test("verify dengan password salah → false", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(hash, "WrongPassword123"), false);
});

test(`password kurang dari ${PASSWORD_MIN_LENGTH} karakter → throw`, async () => {
  await assert.rejects(hashPassword("short"), /at least 12 characters/);
  await assert.rejects(hashPassword(""), /at least 12 characters/);
});

test("hash dua kali untuk password sama → hasil berbeda (salt acak)", async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(first, PASSWORD), true);
  assert.equal(await verifyPassword(second, PASSWORD), true);
});

test("hash invalid → false, tidak throw", async () => {
  assert.equal(await verifyPassword("not-a-hash", PASSWORD), false);
  assert.equal(await verifyPassword("", PASSWORD), false);
});

test("hash memakai Argon2id dengan parameter OWASP (m=19456, t=2, p=1)", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(hash.includes(PASSWORD), false);
});
