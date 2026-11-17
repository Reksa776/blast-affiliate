// End-to-end audit tests (P0.7, T1–T6) against a real `next dev` server and the
// real test database.
//
// Why HTTP and not the handlers directly: the routes import `next/server`, which
// Node cannot resolve outside the bundler.
//
// Isolation: this file runs against TEST_DATABASE_URL (never the development
// database), truncates every M1 table, and takes the shared test-database lock so it
// cannot interleave with the other suites that own the same schema.
//
// The assertions are about what an auditor would see: the action, the actor type,
// the reason code, the hashed IP, and — most importantly — the absence of any
// password, token or secret in the stored metadata.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { acquireTestDbLock } from "../../../../lib/auth/test-lock.ts";
import { loadEnvForTests, requireTestDatabaseUrl } from "../../../../lib/auth/test-env.ts";

loadEnvForTests();

const testDatabaseUrl = requireTestDatabaseUrl();
if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must not be the development database.");
}
process.env.DATABASE_URL = testDatabaseUrl;
delete process.env.MIGRATE_DATABASE_URL;

const { disconnectPrisma, systemDb } = await import("@affiliateos/database");
const { getSessionCookieName } = await import("../../../../lib/auth/cookie-name.ts");
const SESSION_COOKIE = getSessionCookieName();

const PORT = 3418;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "audit-admin@test.local";
const PASSWORD = "SuperSecret12345";
const WRONG_PASSWORD = "WrongPassword12345";
const IP_REGISTER = "198.51.100.11";
const IP_LOGIN = "198.51.100.12";
const REQUEST_ID = "req-audit-1";

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

type PostOptions = { ip: string; csrf?: string; session?: string; requestId?: string };

async function post(path: string, body: unknown, options: PostOptions): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": options.ip,
  };
  if (options.requestId !== undefined) headers["x-request-id"] = options.requestId;

  const cookies: string[] = [];
  if (options.csrf !== undefined) {
    headers["x-csrf-token"] = options.csrf;
    cookies.push(`csrf_token=${options.csrf}`);
  }
  if (options.session !== undefined) cookies.push(options.session);
  if (cookies.length > 0) headers.cookie = cookies.join("; ");

  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function fetchCsrf(ip: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/csrf`, { headers: { "x-forwarded-for": ip } });
  const body = (await response.json()) as { csrfToken?: string };
  return body.csrfToken ?? "";
}

async function auditRows() {
  return systemDb().auditLog.findMany({ orderBy: { createdAt: "asc" } });
}

describe("audit trail dari route auth", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await truncateTestDatabase();
    assert.equal(await systemDb().user.count(), 0, "bootstrap needs an empty users table");

    server = spawn(nextBin, ["dev", "-p", String(PORT)], {
      cwd: join(repoRoot, "apps", "web"),
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
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
    assert.equal(await systemDb().auditLog.count(), 0);
    assert.equal(await systemDb().user.count(), 0);

    await disconnectPrisma();
    releaseLock();
  });

  it("T1: register bootstrap → auth.register_bootstrap, actorType SYSTEM", async () => {
    const csrf = await fetchCsrf(IP_REGISTER);
    const response = await post(
      "/api/auth/register",
      { email: EMAIL, password: PASSWORD, name: "Audit Admin" },
      { ip: IP_REGISTER, csrf, requestId: REQUEST_ID },
    );

    assert.equal(response.status, 201);
    const created = (await response.json()) as { id: string };

    const rows = await auditRows();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.action, "auth.register_bootstrap");
    assert.equal(row.actorType, "SYSTEM");
    assert.equal(row.tenantId, null);
    assert.equal(row.actorUserId, created.id);
    assert.equal(row.resourceType, "user");
    assert.equal(row.resourceId, created.id);
    assert.equal(row.requestId, REQUEST_ID);
    assert.deepEqual(row.metadata, { email: EMAIL });
  });

  it("T2: login sukses → auth.login, actorType USER", async () => {
    const before = (await auditRows()).length;
    const csrf = await fetchCsrf(IP_LOGIN);
    const response = await post(
      "/api/auth/login",
      { email: EMAIL, password: PASSWORD },
      { ip: IP_LOGIN, csrf },
    );

    assert.equal(response.status, 200);
    const sessionCookie = cookieValue(response, SESSION_COOKIE);
    assert.ok(sessionCookie.length > 0, "login harus mengembalikan cookie session");

    const rows = await auditRows();
    assert.equal(rows.length, before + 1);
    const row = rows.at(-1);
    assert.ok(row);
    assert.equal(row.action, "auth.login");
    assert.equal(row.actorType, "USER");
    assert.equal(row.tenantId, null);
    assert.equal(row.metadata && (row.metadata as Record<string, unknown>).email, EMAIL);
    assert.equal(JSON.stringify(row.metadata).includes(PASSWORD), false);
  });

  it("T3: login gagal → auth.login_failed dengan reason, tanpa password", async () => {
    const before = (await auditRows()).length;
    const csrf = await fetchCsrf(IP_LOGIN);
    const response = await post(
      "/api/auth/login",
      { email: EMAIL, password: WRONG_PASSWORD },
      { ip: IP_LOGIN, csrf },
    );

    assert.equal(response.status, 401);

    const rows = await auditRows();
    assert.equal(rows.length, before + 1);
    const row = rows.at(-1);
    assert.ok(row);
    assert.equal(row.action, "auth.login_failed");
    assert.equal(row.actorType, "USER");

    const metadata = row.metadata as Record<string, unknown>;
    assert.equal(metadata.reason, "invalid_password");
    assert.equal(metadata.email_attempted, EMAIL);

    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes(WRONG_PASSWORD), false);
    assert.equal(serialized.includes(PASSWORD), false);
    assert.equal("password" in metadata, false);
  });

  it("T4: logout → auth.logout", async () => {
    const before = (await auditRows()).length;

    const csrfLogin = await fetchCsrf(IP_LOGIN);
    const loginResponse = await post(
      "/api/auth/login",
      { email: EMAIL, password: PASSWORD },
      { ip: IP_LOGIN, csrf: csrfLogin },
    );
    assert.equal(loginResponse.status, 200);
    const sessionCookie = cookieValue(loginResponse, SESSION_COOKIE);

    const csrfLogout = await fetchCsrf(IP_LOGIN);
    const logoutResponse = await post("/api/auth/logout", {}, { ip: IP_LOGIN, csrf: csrfLogout, session: sessionCookie });
    assert.equal(logoutResponse.status, 204);

    const rows = await auditRows();
    // +1 login, +1 logout
    assert.equal(rows.length, before + 2);
    const row = rows.at(-1);
    assert.ok(row);
    assert.equal(row.action, "auth.logout");
    assert.equal(row.actorType, "USER");
    assert.equal(row.tenantId, null);
  });

  it("T5: ipHash adalah SHA-256 32 byte dari IP, bukan plaintext", async () => {
    const rows = await auditRows();
    const registerRow = rows.find((row) => row.action === "auth.register_bootstrap");
    assert.ok(registerRow, "baris register harus ada");

    const stored = Buffer.from(registerRow.ipHash ?? new Uint8Array());
    const expected = crypto.createHash("sha256").update(IP_REGISTER, "utf8").digest();

    assert.equal(stored.length, 32);
    assert.ok(stored.equals(expected), "ipHash harus SHA-256 dari x-forwarded-for");
    assert.equal(stored.toString("hex").length, 64);

    for (const row of rows) {
      const bytes = Buffer.from(row.ipHash ?? new Uint8Array());
      assert.equal(bytes.toString("utf8").includes("198.51.100"), false, "IP plaintext tidak boleh tersimpan");
    }
  });

  it("T6: tidak ada metadata yang memuat password/token/secret", async () => {
    const rows = await auditRows();
    assert.ok(rows.length >= 4);

    for (const row of rows) {
      const serialized = JSON.stringify(row.metadata ?? {});
      assert.equal(serialized.includes(PASSWORD), false, `password bocor di ${row.action}`);
      assert.equal(serialized.includes(WRONG_PASSWORD), false, `password salah bocor di ${row.action}`);
      assert.equal(serialized.includes("csrf_token"), false, `csrf bocor di ${row.action}`);
      assert.equal(serialized.includes("Bearer"), false, `token bocor di ${row.action}`);

      for (const key of Object.keys((row.metadata ?? {}) as Record<string, unknown>)) {
        assert.equal(/password|token|secret|csrf|cookie|authorization/i.test(key), false, `kunci sensitif tersimpan: ${key}`);
      }
    }
  });
});
