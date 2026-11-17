// Accept-invitation end-to-end tests (Phase 2, item 2.2) against a real `next dev`
// server and the real test database.
//
// Proves:
//   - the dev-only token echo makes the flow testable without a mail transport;
//   - a valid token activates an ACTIVE membership and assigns the invited role;
//   - a wrong token, an expired token, a mismatched email and a reused token are
//     all refused, and refusal leaves no membership behind;
//   - the acceptance writes exactly one `member.accept_invite` audit row with a
//     non-null tenant, both actor ids, a 32-byte ip_hash, and no token material.
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

const PORT = 3421;
const BASE = `http://127.0.0.1:${PORT}`;
const IP = "203.0.113.41";

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
type Invitation = { id: string; devToken: string };

let server: ChildProcess | undefined;
let serverLog = "";
let releaseLock: () => void = () => undefined;

const owner: FixtureUser = { userId: "", email: "", token: "" };
const member: FixtureUser = { userId: "", email: "", token: "" };
const wrongUser: FixtureUser = { userId: "", email: "", token: "" };
const expiredUser: FixtureUser = { userId: "", email: "", token: "" };

const workspace = { id: "" };
let memberInvitation: Invitation = { id: "", devToken: "" };
let wrongUserInvitation: Invitation = { id: "", devToken: "" };
let expiredInvitation: Invitation = { id: "", devToken: "" };

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
      displayName: `Accept ${label}`,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
    },
  });

  const { token } = await createSession(userId, IP, "accept-invitation-test");
  return { userId, email, token };
}

async function fetchCsrf(): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/csrf`, { headers: { "x-forwarded-for": IP } });
  const body = (await response.json()) as { csrfToken?: string };
  return body.csrfToken ?? "";
}

type RequestOptions = { session?: string; csrf?: string; body?: unknown; requestId?: string };

/** Value of a rotated session cookie in a response (8C: create/accept rotate). */
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

async function invite(user: FixtureUser, roleKey: string): Promise<Invitation> {
  const response = await api("POST", `/api/workspaces/${workspace.id}/members`, {
    session: owner.token,
    csrf: await fetchCsrf(),
    body: { email: user.email, roleKey },
  });

  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { id: string; devToken?: string };
  assert.equal(typeof body.devToken, "string", "dev-only token echo harus aktif di test");
  return { id: body.id, devToken: body.devToken ?? "" };
}

async function accept(user: FixtureUser, token: string, requestId?: string): Promise<Response> {
  return api("POST", "/api/invitations/accept", {
    session: user.token,
    csrf: await fetchCsrf(),
    requestId,
    body: { token },
  });
}

describe("accept invitation", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await prepareTestDatabase();

    Object.assign(owner, await createFixtureUser("owner"));
    Object.assign(member, await createFixtureUser("member"));
    Object.assign(wrongUser, await createFixtureUser("wrong"));
    Object.assign(expiredUser, await createFixtureUser("expired"));

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
      body: { name: "Accept Workspace", slug: `accept-${crypto.randomUUID().slice(0, 8)}` },
    });
    assert.equal(created.status, 201, await created.clone().text());
    workspace.id = ((await created.json()) as { id: string }).id;
    owner.token = sessionTokenFrom(created) || owner.token;

    memberInvitation = await invite(member, "ANALYST");
    wrongUserInvitation = await invite(wrongUser, "VIEWER");
    expiredInvitation = await invite(expiredUser, "VIEWER");

    // SYSTEM: fixture setup — force one invitation past its expiry.
    await systemDb().workspaceInvitation.update({
      where: { id: expiredInvitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
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

  it("token salah ditolak 400 dan tidak membuat membership", async () => {
    const response = await accept(member, `not-a-real-token-${crypto.randomUUID()}`);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid or expired invitation" });

    const membership = await systemDb().workspaceMember.findUnique({
      where: { tenantId_userId: { tenantId: workspace.id, userId: member.userId } },
      select: { id: true },
    });
    assert.equal(membership, null);
  });

  it("email session tidak cocok dengan invitation → 403", async () => {
    const response = await accept(member, wrongUserInvitation.devToken);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });

    const membership = await systemDb().workspaceMember.findUnique({
      where: { tenantId_userId: { tenantId: workspace.id, userId: member.userId } },
      select: { id: true },
    });
    assert.equal(membership, null, "email yang salah tidak boleh mengaktifkan membership");
  });

  it("token valid mengaktifkan membership ACTIVE + role + audit", async () => {
    const response = await accept(member, memberInvitation.devToken, "req-accept-invite");

    assert.equal(response.status, 200, await response.clone().text());
    // 8C: accepting an invitation rotates the caller's session; keep the new token
    // so the later "already used" test still reaches the invitation logic.
    member.token = sessionTokenFrom(response) || member.token;
    const body = (await response.json()) as {
      workspaceId: string;
      memberId: string;
      roleKey: string;
      status: string;
    };
    assert.equal(body.workspaceId, workspace.id);
    assert.equal(body.roleKey, "ANALYST");
    assert.equal(body.status, "active");

    const membership = await systemDb().workspaceMember.findUnique({
      where: { tenantId_userId: { tenantId: workspace.id, userId: member.userId } },
      select: {
        id: true,
        status: true,
        joinedAt: true,
        roleAssignments: { select: { role: { select: { key: true } } } },
      },
    });
    assert.ok(membership);
    assert.equal(membership.id, body.memberId);
    assert.equal(membership.status, "ACTIVE");
    assert.ok(membership.joinedAt);
    assert.deepEqual(
      membership.roleAssignments.map((assignment) => assignment.role.key),
      ["ANALYST"],
    );

    const invitation = await systemDb().workspaceInvitation.findUnique({
      where: { id: memberInvitation.id },
      select: { status: true, acceptedAt: true, acceptedByUserId: true },
    });
    assert.equal(invitation?.status, "ACCEPTED");
    assert.ok(invitation?.acceptedAt);
    assert.equal(invitation?.acceptedByUserId, member.userId);

    const rows = await systemDb().auditLog.findMany({
      where: { action: "member.accept_invite" },
    });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.tenantId, workspace.id, "tenant_id harus workspace, bukan null");
    assert.equal(row.actorType, "USER");
    assert.equal(row.actorUserId, member.userId);
    assert.equal(row.actorMemberId, body.memberId);
    assert.equal(row.resourceType, "workspace_invitation");
    assert.equal(row.resourceId, memberInvitation.id);
    assert.equal(row.requestId, "req-accept-invite");
    assert.deepEqual(row.metadata, { email: member.email, roleKey: "ANALYST" });

    const serialized = JSON.stringify(row.metadata ?? {});
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes(memberInvitation.devToken), false);

    const expectedIp = crypto.createHash("sha256").update(IP, "utf8").digest();
    const ipBytes = Buffer.from(row.ipHash ?? new Uint8Array());
    assert.equal(ipBytes.length, 32);
    assert.ok(ipBytes.equals(expectedIp));
  });

  it("token kedaluwarsa ditolak 400 dan tidak membuat membership", async () => {
    const response = await accept(expiredUser, expiredInvitation.devToken);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid or expired invitation" });

    const membership = await systemDb().workspaceMember.findUnique({
      where: { tenantId_userId: { tenantId: workspace.id, userId: expiredUser.userId } },
      select: { id: true },
    });
    assert.equal(membership, null);
  });

  it("token yang sudah dipakai tidak bisa dipakai ulang", async () => {
    const response = await accept(member, memberInvitation.devToken);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid or expired invitation" });
    assert.equal(await systemDb().auditLog.count({ where: { action: "member.accept_invite" } }), 1);
  });
});
