// Office-settings tests (Phase 2, items 2.6 + 2.7) against a real `next dev` server.
//
// Covers: default values for a fresh workspace, a successful PATCH across all four
// new columns, validation rejections that leave the row untouched, a no-op PATCH
// that writes no audit, and the cross-tenant refusal shape.
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

const PORT = 3424;
const BASE = `http://127.0.0.1:${PORT}`;
const IP = "203.0.113.61";

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
type OfficeBody = {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  workStart: string;
  workEnd: string;
};

let server: ChildProcess | undefined;
let serverLog = "";
let releaseLock: () => void = () => undefined;

const owner: FixtureUser = { userId: "", email: "", token: "" };
const outsider: FixtureUser = { userId: "", email: "", token: "" };
const workspace = { id: "", slug: "", name: "Office Workspace" };
let ownerMemberId = "";
let missingWorkspaceId = "";

const UPDATED = {
  name: "Head Office Jakarta",
  address: "Jl. Sudirman No. 1, Jakarta",
  timezone: "Asia/Makassar",
  workStart: "08:30",
  workEnd: "17:30",
};

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
      displayName: `Office ${label}`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    },
  });

  const { token } = await createSession(userId, IP, "office-settings-test");
  return { userId, email, token };
}

async function fetchCsrf(): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/csrf`, { headers: { "x-forwarded-for": IP } });
  const body = (await response.json()) as { csrfToken?: string };
  return body.csrfToken ?? "";
}

type RequestOptions = { session?: string; csrf?: string; body?: unknown; requestId?: string };

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

async function api(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "x-forwarded-for": IP };
  const cookies: string[] = [];

  if (options.requestId !== undefined) headers["x-request-id"] = options.requestId;
  if (options.csrf !== undefined) {
    headers["x-csrf-token"] = options.csrf;
    cookies.push(`csrf_token=${options.csrf}`);
  }
  if (options.session !== undefined) cookies.push(`${SESSION_COOKIE}=${options.session}`);
  if (cookies.length > 0) headers.cookie = cookies.join("; ");

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  return fetch(`${BASE}${path}`, init);
}

async function getOffice(): Promise<Response> {
  return api("GET", `/api/workspaces/${workspace.id}/office`, { session: owner.token });
}

async function patchOffice(body: unknown, requestId?: string): Promise<Response> {
  return api("PATCH", `/api/workspaces/${workspace.id}/office`, {
    session: owner.token,
    csrf: await fetchCsrf(),
    requestId,
    body,
  });
}

describe("office settings", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await prepareTestDatabase();

    Object.assign(owner, await createFixtureUser("owner"));
    Object.assign(outsider, await createFixtureUser("outsider"));
    missingWorkspaceId = crypto.randomUUID();

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

    const created = await api("POST", "/api/workspaces", {
      session: owner.token,
      csrf: await fetchCsrf(),
      body: { name: workspace.name, slug: `office-${crypto.randomUUID().slice(0, 8)}` },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = (await created.json()) as { id: string; slug: string };
    workspace.id = createdBody.id;
    workspace.slug = createdBody.slug;
    // 8C: the create response carries a rotated session; later calls use it.
    owner.token = sessionTokenFrom(created) || owner.token;

    const membership = await systemDb().workspaceMember.findFirst({
      where: { tenantId: workspace.id, userId: owner.userId },
      select: { id: true },
    });
    assert.ok(membership);
    ownerMemberId = membership.id;
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

  it("GET mengembalikan nilai default untuk workspace baru", async () => {
    const response = await getOffice();
    assert.equal(response.status, 200, await response.clone().text());

    const body = (await response.json()) as OfficeBody;
    assert.equal(body.id, workspace.id);
    assert.equal(body.name, workspace.name);
    assert.equal(body.address, null);
    assert.equal(body.timezone, "Asia/Jakarta");
    assert.equal(body.workStart, "09:00");
    assert.equal(body.workEnd, "17:00");

    const anonymous = await api("GET", `/api/workspaces/${workspace.id}/office`);
    assert.equal(anonymous.status, 401);
  });

  it("PATCH valid menyimpan ke tenant yang benar dan menulis audit from/to", async () => {
    const before = await systemDb().auditLog.count();

    const response = await patchOffice(UPDATED, "req-office-update");
    assert.equal(response.status, 200, await response.clone().text());

    const body = (await response.json()) as OfficeBody;
    assert.equal(body.name, UPDATED.name);
    assert.equal(body.address, UPDATED.address);
    assert.equal(body.timezone, UPDATED.timezone);
    assert.equal(body.workStart, UPDATED.workStart);
    assert.equal(body.workEnd, UPDATED.workEnd);

    const stored = await systemDb().workspace.findUnique({
      where: { id: workspace.id },
      select: { name: true, address: true, timezone: true, workStart: true, workEnd: true },
    });
    assert.deepEqual(stored, UPDATED);

    assert.equal(await systemDb().auditLog.count(), before + 1);
    const rows = await systemDb().auditLog.findMany({ orderBy: { createdAt: "asc" } });
    const row = rows.at(-1);
    assert.ok(row);

    assert.equal(row.action, "workspace.update_office");
    assert.equal(row.tenantId, workspace.id);
    assert.equal(row.actorType, "USER");
    assert.equal(row.actorUserId, owner.userId);
    assert.equal(row.actorMemberId, ownerMemberId);
    assert.equal(row.resourceType, "workspace");
    assert.equal(row.resourceId, workspace.id);
    assert.equal(row.requestId, "req-office-update");

    assert.deepEqual(row.metadata, {
      fields: ["name", "address", "timezone", "workStart", "workEnd"],
      from: {
        name: workspace.name,
        address: null,
        timezone: "Asia/Jakarta",
        workStart: "09:00",
        workEnd: "17:00",
      },
      to: UPDATED,
    });
  });

  it("validasi menolak timezone, jam, nama dan alamat yang tidak sah", async () => {
    const cases: Array<unknown> = [
      { timezone: "Mars/Olympus" },
      { workStart: "25:00" },
      { workEnd: "17:60" },
      { name: "" },
      { address: "x".repeat(256) },
    ];

    for (const body of cases) {
      const response = await patchOffice(body);
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} harus 400`);
    }

    const stored = await systemDb().workspace.findUnique({
      where: { id: workspace.id },
      select: { name: true, address: true, timezone: true, workStart: true, workEnd: true },
    });
    assert.deepEqual(stored, UPDATED, "PATCH yang ditolak tidak boleh mengubah baris");
  });

  it("PATCH tanpa field yang didukung → 400", async () => {
    const response = await patchOffice({ unknownField: "x" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "No supported fields provided" });
  });

  it("PATCH tanpa perubahan → 200 tanpa audit baru", async () => {
    const before = await systemDb().auditLog.count();
    const response = await patchOffice(UPDATED);

    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as OfficeBody;
    assert.equal(body.timezone, UPDATED.timezone);
    assert.equal(await systemDb().auditLog.count(), before);
  });

  it("workspace asing dan workspace tidak ada memberi 403 yang identik", async () => {
    const foreign = await api("GET", `/api/workspaces/${workspace.id}/office`, {
      session: outsider.token,
    });
    const missing = await api("GET", `/api/workspaces/${missingWorkspaceId}/office`, {
      session: outsider.token,
    });

    assert.equal(foreign.status, 403);
    assert.equal(missing.status, 403);
    assert.equal(await foreign.text(), await missing.text());

    const patch = await api("PATCH", `/api/workspaces/${workspace.id}/office`, {
      session: outsider.token,
      csrf: await fetchCsrf(),
      body: { name: "Hijacked" },
    });
    assert.equal(patch.status, 403);
  });
});
