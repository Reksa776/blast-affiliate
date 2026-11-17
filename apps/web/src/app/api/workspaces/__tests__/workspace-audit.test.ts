// Workspace audit integration tests (P0.8, T1–T6) against a real `next dev` server
// and the real test database. Closes TD-7E-R4 (workspace actions were unaudited).
//
// What an auditor needs from these rows, and what is asserted here:
//   - the action name is the documented `domain.verb`;
//   - tenant_id is the WORKSPACE id — a null tenant on a workspace action would make
//     the row unattributable (the P0.8 red flag);
//   - actor_user_id and actor_member_id are both present and correct, so the row
//     survives being read without a join;
//   - the metadata is useful and free of secrets;
//   - ip_hash is the SHA-256 of the client address, never the address.
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

const PORT = 3420;
const BASE = `http://127.0.0.1:${PORT}`;
const IP = "203.0.113.30";

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

const owner = { userId: "", email: "", token: "" };
const target = { userId: "", email: "", memberId: "" };
const workspace = { id: "", slug: "", name: "Audit Workspace" };
let ownerMemberId = "";

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

async function createFixtureUser(label: string): Promise<{ userId: string; email: string; token: string }> {
  const userId = crypto.randomUUID();
  const email = `${label}-${userId.slice(0, 8)}@test.local`;

  await systemDb().user.create({
    data: {
      id: userId,
      email,
      displayName: `Audit ${label}`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    },
  });

  const { token } = await createSession(userId, IP, "workspace-audit-test");
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

async function lastAuditRow() {
  const rows = await systemDb().auditLog.findMany({ orderBy: { createdAt: "asc" } });
  const row = rows.at(-1);
  assert.ok(row, "harus ada baris audit");
  return row;
}

describe("audit trail dari route workspace", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await prepareTestDatabase();

    Object.assign(owner, await createFixtureUser("owner"));

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

    await clearTestDatabase();
    await disconnectPrisma();
    releaseLock();
  });

  it("T1: POST /api/workspaces → workspace.create dengan tenant_id = workspace", async () => {
    assert.equal(await systemDb().auditLog.count(), 0, "tabel audit harus kosong di awal");

    const response = await api("POST", "/api/workspaces", {
      session: owner.token,
      csrf: await fetchCsrf(),
      requestId: "req-ws-create",
      body: { name: workspace.name, slug: `audit-${crypto.randomUUID().slice(0, 8)}` },
    });

    assert.equal(response.status, 201, await response.clone().text());
    const body = (await response.json()) as { id: string; slug: string; name: string };
    workspace.id = body.id;
    workspace.slug = body.slug;
    // 8C: the create response carries a rotated session; later calls use it.
    owner.token = sessionTokenFrom(response) || owner.token;

    const row = await lastAuditRow();
    assert.equal(row.action, "workspace.create");
    assert.equal(row.actorType, "USER");
    assert.equal(row.tenantId, workspace.id, "tenant_id harus workspace id, bukan null");
    assert.equal(row.resourceType, "workspace");
    assert.equal(row.resourceId, workspace.id);
    assert.equal(row.requestId, "req-ws-create");
    assert.deepEqual(row.metadata, { name: workspace.name, slug: workspace.slug });
    assert.equal(row.actorUserId, owner.userId);

    // The provisioning the route promises actually happened.
    const roles = await systemDb().role.findMany({
      where: { tenantId: workspace.id },
      select: { key: true },
    });
    assert.equal(roles.length, 6, "enam role default harus dibuat");

    const member = await systemDb().workspaceMember.findFirst({
      where: { tenantId: workspace.id, userId: owner.userId },
      select: { id: true, status: true, roleAssignments: { select: { role: { select: { key: true } } } } },
    });
    assert.ok(member);
    assert.equal(member.status, "ACTIVE");
    assert.deepEqual(
      member.roleAssignments.map((assignment) => assignment.role.key),
      ["WORKSPACE_OWNER"],
    );
    ownerMemberId = member.id;

    assert.equal(row.actorMemberId, ownerMemberId, "actor_member_id harus membership pemilik");
  });

  it("T2: undang member → member.invite dengan metadata { email, roleKey }", async () => {
    Object.assign(target, await createFixtureUser("invitee"));
    const before = await systemDb().auditLog.count();

    const response = await api("POST", `/api/workspaces/${workspace.id}/members`, {
      session: owner.token,
      csrf: await fetchCsrf(),
      requestId: "req-ws-invite",
      body: { email: target.email, roleKey: "ANALYST" },
    });

    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { id: string };
    assert.equal(await systemDb().auditLog.count(), before + 1);

    const row = await lastAuditRow();
    assert.equal(row.action, "member.invite");
    assert.equal(row.tenantId, workspace.id);
    assert.equal(row.resourceType, "workspace_invitation");
    assert.equal(row.resourceId, body.id);
    assert.equal(row.requestId, "req-ws-invite");
    assert.deepEqual(row.metadata, { email: target.email, roleKey: "ANALYST" });

    const serialized = JSON.stringify(row.metadata ?? {});
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("tokenHash"), false);
    assert.equal(serialized.includes("Bearer"), false);
  });

  it("T3: ubah role member → role.change dengan metadata { from, to }", async () => {
    // SYSTEM: there is no accept-invitation endpoint yet, so the target membership is
    // created directly as a fixture and given VIEWER before the change.
    const viewerRole = await systemDb().role.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: workspace.id, key: "VIEWER" } },
      select: { id: true },
    });

    target.memberId = crypto.randomUUID();
    await systemDb().workspaceMember.create({
      data: {
        id: target.memberId,
        tenantId: workspace.id,
        userId: target.userId,
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    });
    await systemDb().memberRole.create({
      data: { tenantId: workspace.id, memberId: target.memberId, roleId: viewerRole.id },
    });

    const before = await systemDb().auditLog.count();
    const response = await api(
      "PATCH",
      `/api/workspaces/${workspace.id}/members/${target.memberId}/role`,
      {
        session: owner.token,
        csrf: await fetchCsrf(),
        requestId: "req-role-change",
        body: { roleKey: "ANALYST" },
      },
    );

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await systemDb().auditLog.count(), before + 1);

    const row = await lastAuditRow();
    assert.equal(row.action, "role.change");
    assert.equal(row.tenantId, workspace.id);
    assert.equal(row.resourceType, "workspace_member");
    assert.equal(row.resourceId, target.memberId);
    assert.deepEqual(row.metadata, { from: "VIEWER", to: "ANALYST" });

    const assignments = await systemDb().memberRole.findMany({
      where: { tenantId: workspace.id, memberId: target.memberId },
      select: { role: { select: { key: true } } },
    });
    assert.deepEqual(
      assignments.map((assignment) => assignment.role.key),
      ["ANALYST"],
      "role lama harus diganti, bukan ditambah",
    );

    // 8C: a role change revokes every session of the affected user.
    const targetSessions = await systemDb().session.findMany({
      where: { userId: target.userId },
      select: { revokedAt: true },
    });
    assert.ok(targetSessions.length > 0, "fixture harus punya sesi untuk target");
    assert.equal(
      targetSessions.every((session) => session.revokedAt !== null),
      true,
      "role change harus mencabut semua sesi user yang diubah",
    );
  });

  it("T4: actor_user_id dan actor_member_id terisi benar di ketiga aksi", async () => {
    const rows = await systemDb().auditLog.findMany({ orderBy: { createdAt: "asc" } });
    assert.deepEqual(
      rows.map((row) => row.action),
      ["workspace.create", "member.invite", "role.change"],
    );

    for (const row of rows) {
      assert.equal(row.actorType, "USER", `actorType di ${row.action}`);
      assert.equal(row.actorUserId, owner.userId, `actor_user_id di ${row.action}`);
      assert.equal(row.actorMemberId, ownerMemberId, `actor_member_id di ${row.action}`);
      assert.equal(row.tenantId, workspace.id, `tenant_id di ${row.action}`);
    }
  });

  it("T5: ip_hash adalah SHA-256 dari alamat klien, bukan plaintext", async () => {
    const rows = await systemDb().auditLog.findMany({ orderBy: { createdAt: "asc" } });
    assert.ok(rows.length >= 3);

    const expected = crypto.createHash("sha256").update(IP, "utf8").digest();

    for (const row of rows) {
      const bytes = Buffer.from(row.ipHash ?? new Uint8Array());
      assert.equal(bytes.length, 32, `panjang ip_hash di ${row.action}`);
      assert.ok(bytes.equals(expected), `ip_hash harus SHA-256(x-forwarded-for) di ${row.action}`);
      assert.equal(bytes.toString("utf8").includes("203.0.113"), false);
    }
  });

  it("T6: perubahan role yang tidak mengubah apa pun tidak menulis audit", async () => {
    const before = await systemDb().auditLog.count();

    const response = await api(
      "PATCH",
      `/api/workspaces/${workspace.id}/members/${target.memberId}/role`,
      { session: owner.token, csrf: await fetchCsrf(), body: { roleKey: "ANALYST" } },
    );

    assert.equal(response.status, 200);
    assert.equal(
      await systemDb().auditLog.count(),
      before,
      "role.change pada role yang sama bukan perubahan: tidak diaudit",
    );
  });
});
