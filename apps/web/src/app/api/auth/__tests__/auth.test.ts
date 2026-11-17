// End-to-end tests for the auth routes (P0.5 + pre-P0.6 CSRF/IP fixes).
//
// These run against a real `next dev` server and the real database: the routes
// import `next/server`, which Node cannot resolve outside the bundler, so calling
// the handlers directly is not possible. The server is started in `before`, polled
// through /api/health, and killed in `after`.
//
// Every mutating call now needs the double-submit pair: the `csrf_token` cookie and
// the matching `X-CSRF-Token` header. The server is started with TRUST_PROXY=true so
// each test can present its own `x-forwarded-for` and keep its rate-limit bucket
// separate (see client-ip.test.ts for the untrusted default).
//
// Isolation: this file runs against TEST_DATABASE_URL (never the development
// database) and truncates every M1 table before and after the run, then asserts the
// tables are empty. Because the bootstrap-only register route needs a globally
// empty `users` table, this suite owns the test database exclusively; the other
// test files do not touch it, so files can run in parallel (TD-7C-A7 resolved).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { acquireTestDbLock } from "../../../../lib/auth/test-lock.ts";
import { loadEnvForTests, requireTestDatabaseUrl } from "../../../../lib/auth/test-env.ts";

loadEnvForTests();

// This suite owns `affiliateos_test`: it truncates every business table so the
// bootstrap register route sees an empty platform. `client.ts` reads
// DATABASE_URL when it is first imported, so the redirect happens here, before the
// dynamic import below. The development database is never opened by this file.
const testDatabaseUrl = requireTestDatabaseUrl();
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must not be the development database.");
}
process.env.DATABASE_URL = testDatabaseUrl;

// `affiliateos_app` has no grant on `affiliateos_test`, so the test database is
// reached with the migrate credential. That makes DATABASE_URL and
// MIGRATE_DATABASE_URL the same account here, which the runtime separation guard
// (packages/database/src/pool.ts) rejects by design — and it must keep rejecting it
// in the application. Removing the variable scopes the exemption to this test
// process only; TD-7C-A8 tracks granting the DML account on the test schema.
delete process.env.MIGRATE_DATABASE_URL;

const { disconnectPrisma, systemDb } = await import("@affiliateos/database");

/**
 * Empties every M1 table in the test database, children first. Order matters: the
 * composite FKs are RESTRICT/CASCADE but an explicit order keeps the helper
 * independent of which cascade a future migration chooses.
 */
async function truncateTestDatabase(): Promise<void> {
  const db = systemDb();

  await db.memberRole.deleteMany();
  await db.rolePermission.deleteMany();
  await db.workspaceInvitation.deleteMany();
  await db.workspaceMember.deleteMany();
  await db.session.deleteMany();
  await db.platformAdminGrant.deleteMany();
  await db.auditLog.deleteMany();
  await db.backgroundJobAttempt.deleteMany();
  await db.backgroundJob.deleteMany();
  await db.role.deleteMany();
  await db.permission.deleteMany();
  await db.workspace.deleteMany();
  await db.user.deleteMany();
}

const PORT = 3417;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "admin@test.local";
const PASSWORD = "SuperSecret12345";

const IP_REGISTER = "198.51.100.1";
const IP_LOGIN = "198.51.100.2";
const IP_LIMIT = "203.0.113.7";

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
// The RBAC suites share this database; only one suite may truncate at a time.
let releaseLock: () => void = () => undefined;

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

// `Headers.getSetCookie` exists in Node's fetch but not in the DOM lib typings that
// this tsconfig includes, so the access is narrowed once instead of cast per call.
function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single === null ? [] : [single];
}

function cookieValue(response: Response, name: string): string {
  for (const candidate of setCookieHeaders(response)) {
    if (candidate.startsWith(`${name}=`)) return candidate.split(";")[0] ?? "";
  }
  return "";
}

type PostOptions = { ip?: string; csrf?: string; session?: string };

async function post(path: string, body: unknown, options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.ip !== undefined) headers["x-forwarded-for"] = options.ip;

  const cookies: string[] = [];
  if (options.csrf !== undefined) {
    headers["x-csrf-token"] = options.csrf;
    cookies.push(`csrf_token=${options.csrf}`);
  }
  if (options.session !== undefined) cookies.push(options.session);
  if (cookies.length > 0) headers.cookie = cookies.join("; ");

  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** GET /api/auth/csrf and return the token (cookie value equals the body value). */
async function fetchCsrf(ip: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/csrf`, { headers: { "x-forwarded-for": ip } });
  const body = (await response.json()) as { csrfToken?: string };
  return body.csrfToken ?? "";
}

before(async () => {
  releaseLock = await acquireTestDbLock();
  await truncateTestDatabase();
  assert.equal(await systemDb().user.count(), 0, "bootstrap needs an empty users table");

  server = spawn(nextBin, ["dev", "-p", String(PORT)], {
    cwd: join(repoRoot, "apps", "web"),
    // DATABASE_URL is pinned explicitly: `next.config.ts` uses loadEnvFile, which
    // does not override an existing variable, so the server cannot fall back to
    // the development database from `.env`.
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      // Present but empty: `next.config.ts` loads the root .env, which does not
      // overwrite a variable that already exists. Empty is treated by
      // `assertSeparateAccounts` as "not set", so the test DB can use the single
      // credential it has a grant for (TD-7C-A8).
      MIGRATE_DATABASE_URL: "",
      NEXT_TELEMETRY_DISABLED: "1",
      TRUST_PROXY: "true",
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

  await truncateTestDatabase();

  assert.equal(await systemDb().user.count(), 0);
  assert.equal(await systemDb().session.count(), 0);

  await disconnectPrisma();
  releaseLock();
});

describe("auth API", () => {
  let userId = "";
  let sessionCookie = "";
  let csrf = "";

  it("POST /api/auth/register tanpa CSRF → 403 (dan tidak membuat user)", async () => {
    const response = await post(
      "/api/auth/register",
      { email: EMAIL, password: PASSWORD, name: "Admin" },
      { ip: IP_REGISTER },
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 403);
    assert.equal(body.error, "Missing CSRF token");
    assert.equal(await systemDb().user.count(), 0);
  });

  it("GET /api/auth/csrf → 200, cookie csrf_token yang bisa dibaca JS, token 43 char", async () => {
    const response = await fetch(`${BASE}/api/auth/csrf`, { headers: { "x-forwarded-for": IP_REGISTER } });
    const body = (await response.json()) as { csrfToken?: string };

    assert.equal(response.status, 200);
    assert.equal(typeof body.csrfToken, "string");
    assert.equal(body.csrfToken?.length, 43);

    const setCookie = setCookieHeaders(response).join("\n");
    assert.match(setCookie, /csrf_token=/);
    assert.match(setCookie, /SameSite=lax/i);
    assert.match(setCookie, /Path=\//i);
    assert.equal(/HttpOnly/i.test(setCookie), false, "cookie CSRF harus bisa dibaca client");

    csrf = body.csrfToken ?? "";
  });

  it("POST /api/auth/login tanpa CSRF → 403", async () => {
    const response = await post("/api/auth/login", { email: EMAIL, password: PASSWORD }, { ip: IP_LOGIN });
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 403);
    assert.equal(body.error, "Missing CSRF token");
  });

  it("POST /api/auth/register (bootstrap) dengan CSRF → 201 tanpa passwordHash", async () => {
    const response = await post(
      "/api/auth/register",
      { email: EMAIL, password: PASSWORD, name: "Admin" },
      { ip: IP_REGISTER, csrf },
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 201);
    assert.equal(body.email, EMAIL);
    assert.equal(body.name, "Admin");
    assert.equal(typeof body.id, "string");
    assert.equal("passwordHash" in body, false);
    assert.equal(JSON.stringify(body).includes("argon2"), false);

    userId = String(body.id);

    const stored = await systemDb().user.findUnique({
      where: { email: EMAIL },
      select: { id: true, passwordHash: true },
    });
    assert.ok(stored);
    assert.equal(stored.id, userId);
    assert.match(stored.passwordHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(stored.passwordHash.includes(PASSWORD), false);
  });

  it("POST /api/auth/register kedua kali → 403 (bootstrap tertutup)", async () => {
    const response = await post(
      "/api/auth/register",
      { email: "second@test.local", password: PASSWORD, name: "Second" },
      { ip: IP_REGISTER, csrf },
    );

    assert.equal(response.status, 403);
    assert.equal(await systemDb().user.count(), 1);
  });

  it("POST /api/auth/register dengan payload tidak valid → 400", async () => {
    const response = await post(
      "/api/auth/register",
      { email: "not-an-email", password: "short", name: "" },
      { ip: IP_REGISTER, csrf },
    );

    assert.equal(response.status, 400);
  });

  it("POST /api/auth/login dengan kredensial benar + CSRF → 200 + cookie session", async () => {
    const response = await post("/api/auth/login", { email: EMAIL, password: PASSWORD }, { ip: IP_LOGIN, csrf });
    const body = (await response.json()) as { user?: Record<string, unknown> };

    assert.equal(response.status, 200);
    assert.equal(body.user?.email, EMAIL);
    assert.equal("passwordHash" in (body.user ?? {}), false);

    const setCookie = setCookieHeaders(response).join("\n");
    assert.match(setCookie, /session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=lax/i);

    sessionCookie = cookieValue(response, "session");
    assert.notEqual(sessionCookie, "");
    assert.equal(await systemDb().session.count({ where: { userId } }), 1);
  });

  it("POST /api/auth/login dengan password salah → 401", async () => {
    const response = await post(
      "/api/auth/login",
      { email: EMAIL, password: "WrongPassword123" },
      { ip: IP_LOGIN, csrf },
    );

    assert.equal(response.status, 401);
    assert.equal(await systemDb().session.count({ where: { userId } }), 1);
  });

  it("POST /api/auth/logout tanpa CSRF → 403 dan session tetap hidup", async () => {
    const response = await post("/api/auth/logout", {}, { ip: IP_LOGIN, session: sessionCookie });
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 403);
    assert.equal(body.error, "Missing CSRF token");
    assert.equal(await systemDb().session.count({ where: { userId } }), 1);
  });

  it("GET /api/auth/me tanpa cookie → 401", async () => {
    const response = await fetch(`${BASE}/api/auth/me`);

    assert.equal(response.status, 401);
  });

  it("GET /api/auth/me dengan cookie valid → 200 tanpa passwordHash", async () => {
    const response = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: sessionCookie } });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["email", "id", "name"]);
    assert.equal(body.id, userId);
    assert.equal(body.email, EMAIL);
    assert.equal(body.name, "Admin");
  });

  it("POST /api/auth/logout dengan CSRF → 204 dan cookie dikosongkan", async () => {
    const response = await post(
      "/api/auth/logout",
      {},
      { ip: IP_LOGIN, csrf, session: sessionCookie },
    );

    assert.equal(response.status, 204);

    const setCookie = setCookieHeaders(response).join("\n");
    assert.match(setCookie, /session=;/);
    assert.match(setCookie, /Max-Age=0/i);
    assert.equal(await systemDb().session.count({ where: { userId } }), 0);
  });

  it("GET /api/auth/me setelah logout → 401", async () => {
    const response = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: sessionCookie } });

    assert.equal(response.status, 401);
  });

  it("rate limit: percobaan login ke-11 dari IP yang sama → 429 (walau CSRF valid)", async () => {
    const limiterCsrf = await fetchCsrf(IP_LIMIT);
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await post(
        "/api/auth/login",
        { email: "nobody@test.local", password: "WrongPassword123" },
        { ip: IP_LIMIT, csrf: limiterCsrf },
      );
      statuses.push(response.status);
    }

    const blocked = await post(
      "/api/auth/login",
      { email: "nobody@test.local", password: "WrongPassword123" },
      { ip: IP_LIMIT, csrf: limiterCsrf },
    );

    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 401, 401]);
    assert.equal(blocked.status, 429);
  });
});
