// General per-user API rate limit, end to end (P1 HIGH #2).
//
// One real `next dev` server, one real session on `affiliateos_test`. GET
// /api/workspaces is called 300 times with the same cookie: the 300th must succeed
// and the 301st must be 429 with an integer `Retry-After`. The limit is left at its
// documented default (300/min) on purpose — this is the boundary the brief asks
// for, not a shrunken test-only limit.
//
// The server also gets `TRUST_PROXY=true` so the fixture IP is the key, matching the
// other HTTP suites; the rate-limit key itself is the session user id.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { loadEnvForTests, requireTestDatabaseUrl } from "../../../../lib/auth/test-env.ts";
import { acquireTestDbLock } from "../../../../lib/auth/test-lock.ts";

loadEnvForTests();

const testDatabaseUrl = requireTestDatabaseUrl();
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must not be the development database.");
}
process.env.DATABASE_URL = testDatabaseUrl;
delete process.env.MIGRATE_DATABASE_URL;

const { disconnectPrisma, systemDb } = await import("@affiliateos/database");
const { clearTestDatabase, prepareTestDatabase } = await import(
  "../../../../lib/auth/test-fixtures.ts"
);
const { createSession } = await import("../../../../lib/auth/session.ts");
const { getSessionCookieName } = await import("../../../../lib/auth/cookie-name.ts");
const SESSION_COOKIE = getSessionCookieName();

const PORT = 3425;
const BASE = `http://127.0.0.1:${PORT}`;
const LIMIT = 300;

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes('"workspaces"')) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the workspace root above the test process.");
}

const repoRoot = findRepoRoot(process.cwd());
const nextBin = join(repoRoot, "node_modules", ".bin", "next");

let server: ChildProcess | undefined;
let serverLog = "";
let releaseLock: () => void = () => undefined;
let token = "";

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok || response.status === 503) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  throw new Error(`next dev did not become ready.\n${serverLog.slice(-2000)}`);
}

async function callWorkspaces(): Promise<Response> {
  return fetch(`${BASE}/api/workspaces`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

describe("rate limit umum per-user (300/menit)", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await prepareTestDatabase();

    const userId = crypto.randomUUID();
    await systemDb().user.create({
      data: {
        id: userId,
        email: `api-limit-${userId.slice(0, 8)}@test.local`,
        displayName: "API Limit",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
      },
    });

    // Direct session creation: this test is about the general limiter, not login.
    token = (await createSession(userId, "203.0.113.71", "api-rate-limit-test")).token;

    server = spawn(nextBin, ["dev", "-p", String(PORT)], {
      cwd: join(repoRoot, "apps", "web"),
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
        MIGRATE_DATABASE_URL: "",
        NEXT_TELEMETRY_DISABLED: "1",
        TRUST_PROXY: "true",
        API_RATE_LIMIT_USER_MAX: String(LIMIT),
        API_RATE_LIMIT_USER_WINDOW_MS: "60000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });

    await waitForServer();
  });

  after(async () => {
    if (server !== undefined && server.pid !== undefined) {
      server.kill("SIGTERM");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
      if (server.exitCode === null) server.kill("SIGKILL");
    }

    await clearTestDatabase();
    await disconnectPrisma();
    releaseLock();
  });

  it("request ke-300 lolos, request ke-301 → 429 + Retry-After", async () => {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const response = await callWorkspaces();
      assert.equal(response.status, 200, `request ${attempt}: ${await response.clone().text()}`);
      // The body must stay small; this is a read, not a fixture builder.
      const body = (await response.json()) as { workspaces?: unknown[] };
      assert.ok(Array.isArray(body.workspaces));
    }

    const blocked = await callWorkspaces();
    assert.equal(blocked.status, 429, await blocked.clone().text());
    assert.deepEqual(await blocked.json(), { error: "Too many requests" });

    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter), "Retry-After harus bilangan bulat detik");
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After tidak wajar: ${retryAfter}`);
    assert.equal(blocked.headers.get("x-ratelimit-limit"), String(LIMIT));
    assert.equal(blocked.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(blocked.headers.get("x-ratelimit-scope"), "user");
  });
});
