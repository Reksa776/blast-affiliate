// Unit tests for pool parsing and the runtime/migration account separation guard
// (Checkpoint 6D). Pure functions only: no database, no network, fake credentials.

import assert from "node:assert/strict";
import { test } from "node:test";

import { accountKey, assertSeparateAccounts, buildPoolOptions, parseConnectionUrl } from "./pool.js";

const RUNTIME = "mysql://affiliateos_app:s3cret%40value@127.0.0.1:3306/affiliateos";
const MIGRATE = "mysql://affiliateos_migrate:other@127.0.0.1:3306/affiliateos";

test("parseConnectionUrl decodes an encoded password and keeps host/port/database", () => {
  const parsed = parseConnectionUrl(RUNTIME);
  assert.equal(parsed.user, "affiliateos_app");
  assert.equal(parsed.password, "s3cret@value");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 3306);
  assert.equal(parsed.database, "affiliateos");
});

test("parseConnectionUrl defaults the port to 3306", () => {
  const parsed = parseConnectionUrl("mysql://u:p@db.example/affiliateos");
  assert.equal(parsed.port, 3306);
});

test("parseConnectionUrl rejects a non-mysql scheme and an empty database", () => {
  assert.throws(() => parseConnectionUrl("postgres://u:p@h:5432/db"));
  assert.throws(() => parseConnectionUrl("mysql://u:p@h:3306/"));
  assert.throws(() => parseConnectionUrl("not a url"));
});

test("parseConnectionUrl errors never echo the credential", () => {
  try {
    parseConnectionUrl("postgres://user:supersecret@host/db");
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("supersecret"), false);
  }
});

test("buildPoolOptions applies the documented defaults", () => {
  const options = buildPoolOptions(RUNTIME, {});
  assert.equal(options.connectionLimit, 5);
  assert.equal(options.minimumIdle, 1);
  assert.equal(options.timezone, "Z");
  assert.equal(options.idleTimeout, 600);
  assert.equal(options.acquireTimeout, 10_000);
  assert.equal(options.connectTimeout, 10_000);
});

test("buildPoolOptions honours DB_POOL_MAX and clamps minimumIdle to it", () => {
  const options = buildPoolOptions(RUNTIME, { DB_POOL_MAX: "8", DB_POOL_MIN_IDLE: "9" });
  assert.equal(options.connectionLimit, 8);
  assert.equal(options.minimumIdle, 8);
});

test("buildPoolOptions rejects an out-of-range or non-integer DB_POOL_MAX", () => {
  assert.throws(() => buildPoolOptions(RUNTIME, { DB_POOL_MAX: "0" }));
  assert.throws(() => buildPoolOptions(RUNTIME, { DB_POOL_MAX: "51" }));
  assert.throws(() => buildPoolOptions(RUNTIME, { DB_POOL_MAX: "2.5" }));
});

test("accountKey ignores the database name but not the account", () => {
  assert.equal(
    accountKey("mysql://u:p@h:3306/affiliateos"),
    accountKey("mysql://u:p@h:3306/affiliateos_shadow"),
  );
  assert.notEqual(
    accountKey("mysql://u:p@h:3306/affiliateos"),
    accountKey("mysql://other:p@h:3306/affiliateos"),
  );
});

test("assertSeparateAccounts accepts distinct accounts and no migration URL", () => {
  assert.doesNotThrow(() => assertSeparateAccounts(RUNTIME, MIGRATE));
  assert.doesNotThrow(() => assertSeparateAccounts(RUNTIME, undefined));
  assert.doesNotThrow(() => assertSeparateAccounts(RUNTIME, "   "));
});

test("assertSeparateAccounts rejects the same account on the same server", () => {
  assert.throws(
    () => assertSeparateAccounts(RUNTIME, "mysql://affiliateos_app:different@127.0.0.1:3306/affiliateos_shadow"),
    /same database account/,
  );
});
