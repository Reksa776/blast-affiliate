// Per-user workspace-mutation rate limit tests (Phase 2, item 2.4).
//
// The server is started with a deliberately tiny limit (2 per 60s) so the third
// mutation must return 429 with a usable `Retry-After`. Two users are exercised to
// prove the bucket is per user, not global (and not per IP, since both requests come
// from the same address).
//
// Isolation: TEST_DATABASE_URL only, every M1 table truncated, shared test-database
// lock held for the duration.

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

const PORT = 3423;
const BASE = `http://127.0.0.1:${PORT}`;
const IP = "203.0.113.51";

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

type FixtureUser = { userId: string; email: string; token: string };

let server: ChildProcess | undefined;
let serverLog = "";
let releaseLock: () => void = () => undefined;

const limitedUser: FixtureUser = { userId: "", email: "", token: "" };
const otherUser: FixtureUser = { userId: "", email: "", token: "" };
let firstWorkspaceId = "";

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

async function createFixtureUser(label: string): Promise<FixtureUser> {
  const userId = crypto.randomUUID();
  const email = `${label}-${userId.slice(0, 8)}@test.local`;

  await systemDb().user.create({
    data: {
      id: userId,
      email,
      displayName: `Limit ${label}`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    },
  });

  const { token } = await createSession(userId, IP, "workspace-rate-limit-test");
  return { userId, email, token };
}

async function fetchCsrf(): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/csrf`, { headers: { "x-forwarded-for": IP } });
  const body = (await response.json()) as { csrfToken?: string };
  return body.csrfToken ?? "";
}

async function api(method: string, path: string, session: string, body?: unknown): Promise<Response> {
  const csrf = await fetchCsrf();
  const headers: Record<string, string> = {
    "x-forwarded-for": IP,
    "x-csrf-token": csrf,
    cookie: `${SESSION_COOKIE}=${session}; csrf_token=${csrf}`,
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  return fetch(`${BASE}${path}`, init);
}

function createWorkspace(session: string, label: string): Promise<Response> {
  return api("POST", "/api/workspaces", session, {
    name: `Limit ${label}`,
    slug: `limit-${label}-${crypto.randomUUID().slice(0, 8)}`,
  });
}

/** Value of the rotated session cookie in a response (8C: workspace create rotates). */
function sessionTokenFrom(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const all =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];

  for (const cookie of all) {
    if (!cookie.startsWith(`${SESSION_COOKIE}=`)) continue;
    const pair = cookie.split(";")[0] ?? "";
    return pair.slice(SESSION_COOKIE.length + 1);
  }
  return "";
}

describe("rate limit per-user pada route workspace", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await prepareTestDatabase();

    Object.assign(limitedUser, await createFixtureUser("limited"));
    Object.assign(otherUser, await createFixtureUser("other"));

    server = spawn(nextBin, ["dev", "-p", String(PORT)], {
      cwd: join(repoRoot, "apps", "web"),
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
        MIGRATE_DATABASE_URL: "",
        NEXT_TELEMETRY_DISABLED: "1",
        TRUST_PROXY: "true",
        WORKSPACE_RATE_LIMIT_MAX: "2",
        WORKSPACE_RATE_LIMIT_WINDOW_MS: "60000",
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

  it("dua create pertama lolos, create ketiga → 429 + Retry-After", async () => {
    const first = await createWorkspace(limitedUser.token, "a");
    assert.equal(first.status, 201, await first.clone().text());
    const firstBody = (await first.json()) as { id: string };
    firstWorkspaceId = firstBody.id;
    // 8C: the create response carries a rotated session; adopt it for the next call.
    limitedUser.token = sessionTokenFrom(first) || limitedUser.token;

    const second = await createWorkspace(limitedUser.token, "b");
    assert.equal(second.status, 201, await second.clone().text());
    limitedUser.token = sessionTokenFrom(second) || limitedUser.token;

    const third = await createWorkspace(limitedUser.token, "c");
    assert.equal(third.status, 429, await third.clone().text());
    assert.deepEqual(await third.json(), { error: "Too many requests" });

    const retryAfter = Number(third.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter), "Retry-After harus bilangan bulat detik");
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After tidak wajar: ${retryAfter}`);

    // The rejected request must not have provisioned a third workspace.
    const owned = await systemDb().workspaceMember.count({
      where: { userId: limitedUser.userId },
    });
    assert.equal(owned, 2);
  });

  it("bucket dipakai bersama oleh invite pada user yang sama → 429", async () => {
    const response = await api(
      "POST",
      `/api/workspaces/${firstWorkspaceId}/members`,
      limitedUser.token,
      { email: otherUser.email, roleKey: "VIEWER" },
    );

    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) >= 1);

    const invitations = await systemDb().workspaceInvitation.count({
      where: { tenantId: firstWorkspaceId },
    });
    assert.equal(invitations, 0);
  });

  it("user lain memiliki bucket sendiri → 201", async () => {
    const response = await createWorkspace(otherUser.token, "other");
    assert.equal(response.status, 201, await response.clone().text());
  });
});
