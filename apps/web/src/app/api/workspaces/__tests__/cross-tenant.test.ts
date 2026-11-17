// Cross-tenant end-to-end tests (P0.8, T1–T10) against a real `next dev` server and
// the real test database.
//
// Two independent layers are proven here:
//
//   HTTP   — a member of workspace A cannot act on workspace B, and the refusal does
//            not reveal whether B exists. Non-members get 403 for every endpoint.
//   DB     — `withTenant(ctxA)` cannot read B's rows even when asked for them by id,
//            because the scope is merged into the `where` by the query extension.
//
// Isolation: this file runs against TEST_DATABASE_URL (never the development
// database), truncates every M1 table, and holds the shared test-database lock.

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

const {
  createTenantContext,
  disconnectPrisma,
  systemDb,
  withTenant,
} = await import("@affiliateos/database");
const { clearTestDatabase, prepareTestDatabase } = await import(
  "../../../../lib/auth/test-fixtures.ts"
);
const { createSession } = await import("../../../../lib/auth/session.ts");

const PORT = 3419;
const BASE = `http://127.0.0.1:${PORT}`;
const IP = "203.0.113.21";

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

const userA: FixtureUser = { userId: "", email: "", token: "" };
const userB: FixtureUser = { userId: "", email: "", token: "" };
const workspaceA = { id: "", slug: "", name: "Alpha Workspace" };
const workspaceB = { id: "", slug: "", name: "Beta Workspace" };
const membershipA = { id: "" };
const membershipB = { id: "" };
let missingWorkspaceId = "";

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
      displayName: `Cross Tenant ${label}`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    },
  });

  const { token } = await createSession(userId, IP, "cross-tenant-test");
  return { userId, email, token };
}

async function fetchCsrf(): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/csrf`, { headers: { "x-forwarded-for": IP } });
  const body = (await response.json()) as { csrfToken?: string };
  return body.csrfToken ?? "";
}

type RequestOptions = { session?: string; csrf?: string; body?: unknown };

async function api(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "x-forwarded-for": IP };
  const cookies: string[] = [];

  if (options.csrf !== undefined) {
    headers["x-csrf-token"] = options.csrf;
    cookies.push(`csrf_token=${options.csrf}`);
  }
  if (options.session !== undefined) cookies.push(`session=${options.session}`);
  if (cookies.length > 0) headers.cookie = cookies.join("; ");

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  return fetch(`${BASE}${path}`, init);
}

describe("cross-tenant E2E (route workspace)", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await prepareTestDatabase();

    Object.assign(userA, await createFixtureUser("owner-a"));
    Object.assign(userB, await createFixtureUser("owner-b"));

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

    const csrfA = await fetchCsrf();
    const createdA = await api("POST", "/api/workspaces", {
      session: userA.token,
      csrf: csrfA,
      body: { name: workspaceA.name, slug: `alpha-${crypto.randomUUID().slice(0, 8)}` },
    });
    assert.equal(createdA.status, 201, `create workspace A: ${await createdA.clone().text()}`);
    const bodyA = (await createdA.json()) as { id: string; slug: string };
    workspaceA.id = bodyA.id;
    workspaceA.slug = bodyA.slug;

    const csrfB = await fetchCsrf();
    const createdB = await api("POST", "/api/workspaces", {
      session: userB.token,
      csrf: csrfB,
      body: { name: workspaceB.name, slug: `beta-${crypto.randomUUID().slice(0, 8)}` },
    });
    assert.equal(createdB.status, 201, `create workspace B: ${await createdB.clone().text()}`);
    const bodyB = (await createdB.json()) as { id: string; slug: string };
    workspaceB.id = bodyB.id;
    workspaceB.slug = bodyB.slug;

    const a = await systemDb().workspaceMember.findFirst({
      where: { tenantId: workspaceA.id, userId: userA.userId },
      select: { id: true },
    });
    assert.ok(a, "A harus menjadi member workspace A");
    membershipA.id = a.id;

    const b = await systemDb().workspaceMember.findFirst({
      where: { tenantId: workspaceB.id, userId: userB.userId },
      select: { id: true },
    });
    assert.ok(b, "B harus menjadi member workspace B");
    membershipB.id = b.id;

    missingWorkspaceId = crypto.randomUUID();
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

  it("T1: A mengundang ke workspace A → 200", async () => {
    const response = await api("POST", `/api/workspaces/${workspaceA.id}/members`, {
      session: userA.token,
      csrf: await fetchCsrf(),
      body: { email: userB.email, roleKey: "VIEWER" },
    });

    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as {
      id: string;
      email: string;
      roleKey: string;
      status: string;
    };
    assert.equal(body.email, userB.email);
    assert.equal(body.roleKey, "VIEWER");
    assert.equal(body.status, "pending");

    const invitation = await systemDb().workspaceInvitation.findUnique({
      where: { id: body.id },
      select: { tenantId: true, email: true, status: true, tokenHash: true },
    });
    assert.ok(invitation);
    assert.equal(invitation.tenantId, workspaceA.id, "invitation harus milik workspace A");
    assert.equal(invitation.status, "PENDING");
    assert.equal(Buffer.from(invitation.tokenHash).length, 32, "token disimpan sebagai hash 32 byte");
  });

  it("T2: A mengundang ke workspace B → 403", async () => {
    const response = await api("POST", `/api/workspaces/${workspaceB.id}/members`, {
      session: userA.token,
      csrf: await fetchCsrf(),
      body: { email: userA.email, roleKey: "VIEWER" },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });

    const created = await systemDb().workspaceInvitation.count({ where: { tenantId: workspaceB.id } });
    assert.equal(created, 0, "tidak boleh ada invitation yang tercipta di workspace B");
  });

  it("T3: A mengubah role member di workspace B → 403", async () => {
    const response = await api(
      "PATCH",
      `/api/workspaces/${workspaceB.id}/members/${membershipB.id}/role`,
      { session: userA.token, csrf: await fetchCsrf(), body: { roleKey: "VIEWER" } },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });

    const bRoles = await systemDb().memberRole.findMany({
      where: { tenantId: workspaceB.id, memberId: membershipB.id },
      select: { role: { select: { key: true } } },
    });
    assert.deepEqual(
      bRoles.map((row) => row.role.key),
      ["WORKSPACE_OWNER"],
      "role B tidak boleh berubah",
    );
  });

  it("T4: A membaca endpoint workspace B → 403, identik dengan workspace yang tidak ada", async () => {
    const other = await api("GET", `/api/workspaces/${workspaceB.id}/probe`, {
      session: userA.token,
    });
    const missing = await api("GET", `/api/workspaces/${missingWorkspaceId}/probe`, {
      session: userA.token,
    });

    assert.equal(other.status, 403);
    assert.equal(missing.status, 403, "workspace yang tidak ada tidak boleh dibedakan");

    const otherBody = await other.text();
    assert.equal(otherBody, await missing.text(), "body 403 harus identik (tanpa existence oracle)");
    assert.equal(otherBody.includes(workspaceB.id), false, "respons tidak boleh memantulkan id");
  });

  it("T5: B mengundang ke workspace A → 403", async () => {
    const response = await api("POST", `/api/workspaces/${workspaceA.id}/members`, {
      session: userB.token,
      csrf: await fetchCsrf(),
      body: { email: userB.email, roleKey: "VIEWER" },
    });

    assert.equal(response.status, 403);
    const invitations = await systemDb().workspaceInvitation.count({
      where: { tenantId: workspaceA.id, invitedByUserId: userB.userId },
    });
    assert.equal(invitations, 0);
  });

  it("T6: withTenant(ctxA).workspaceMember tidak melihat member workspace B", async () => {
    const ctxA = createTenantContext({
      tenantId: workspaceA.id,
      userId: userA.userId,
      membershipId: membershipA.id,
      actorType: "user",
      requestId: "cross-tenant-t6",
      permissions: ["member.read"],
    });

    const rows = await withTenant(ctxA, (db) =>
      db.workspaceMember.findMany({ select: { tenantId: true, userId: true } }),
    );

    assert.ok(rows.length > 0);
    assert.equal(
      rows.every((row) => row.tenantId === workspaceA.id),
      true,
      "setiap baris harus milik workspace A",
    );
    assert.equal(
      rows.some((row) => row.userId === userB.userId),
      false,
      "member workspace B tidak boleh terbaca",
    );

    // Even asking for B's row by id must fail closed.
    const direct = await withTenant(ctxA, (db) =>
      db.workspaceMember.findFirst({
        where: { id: membershipB.id },
        select: { id: true },
      }),
    );
    assert.equal(direct, null);
  });

  it("T7: withTenant(ctxA).workspace hanya melihat workspace A", async () => {
    const ctxA = createTenantContext({
      tenantId: workspaceA.id,
      userId: userA.userId,
      membershipId: membershipA.id,
      actorType: "user",
      requestId: "cross-tenant-t7",
      permissions: ["workspace.read"],
    });

    const rows = await withTenant(ctxA, (db) => db.workspace.findMany({ select: { id: true } }));
    assert.deepEqual(
      rows.map((row) => row.id),
      [workspaceA.id],
    );

    // `workspaces` is special: its tenant key IS `id`, so the scope does not narrow a
    // foreign id — it replaces it (the context is spread last, on purpose). Asking for
    // B's id therefore yields A, which is the fail-closed shape for this model: B's
    // row is never returned, and there is no case where the caller's id wins.
    const otherById = await withTenant(ctxA, (db) =>
      db.workspace.findFirst({ where: { id: workspaceB.id }, select: { id: true } }),
    );
    assert.notEqual(otherById?.id, workspaceB.id, "workspace B tidak boleh terbaca");
    assert.equal(otherById?.id, workspaceA.id, "scope context menang atas id dari pemanggil");
  });

  it("T8: tanpa session → 401", async () => {
    const response = await api("POST", `/api/workspaces/${workspaceA.id}/members`, {
      csrf: await fetchCsrf(),
      body: { email: userB.email, roleKey: "VIEWER" },
    });

    assert.equal(response.status, 401);
  });

  it("T9: A tanpa CSRF → 403", async () => {
    const response = await api("POST", `/api/workspaces/${workspaceA.id}/members`, {
      session: userA.token,
      body: { email: userB.email, roleKey: "VIEWER" },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Missing CSRF token" });
  });

  it("T10: A tidak bisa mengubah role dirinya sendiri → 400 (anti lock-out)", async () => {
    const response = await api(
      "PATCH",
      `/api/workspaces/${workspaceA.id}/members/${membershipA.id}/role`,
      { session: userA.token, csrf: await fetchCsrf(), body: { roleKey: "VIEWER" } },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "You cannot change your own role" });

    const roles = await systemDb().memberRole.findMany({
      where: { tenantId: workspaceA.id, memberId: membershipA.id },
      select: { role: { select: { key: true } } },
    });
    assert.deepEqual(
      roles.map((row) => row.role.key),
      ["WORKSPACE_OWNER"],
      "A harus tetap WORKSPACE_OWNER",
    );
  });
});
