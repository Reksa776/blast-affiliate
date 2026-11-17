// Readiness probe tests (Phase 2, item 2.3) against a real `next dev` server.
//
//   - full permission catalog + reachable database → 200 "ready";
//   - empty catalog → 503 naming the missing keys, so TD-7F-R2 (workspace
//     provisioning 500 when the catalog is empty) is observable before traffic.
//
// Isolation: TEST_DATABASE_URL only, every M1 table truncated, shared test-database
// lock held for the duration.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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

const PORT = 3422;
const BASE = `http://127.0.0.1:${PORT}`;

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

type ReadyBody = {
  status: string;
  database: string;
  permissionCatalog: { expected: number; actual: number | null; missing: string[] };
  reasons: string[];
};

describe("GET /api/health/ready", () => {
  before(async () => {
    releaseLock = await acquireTestDbLock();
    await prepareTestDatabase();

    server = spawn(nextBin, ["dev", "-p", String(PORT)], {
      cwd: join(repoRoot, "apps", "web"),
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
        MIGRATE_DATABASE_URL: "",
        NEXT_TELEMETRY_DISABLED: "1",
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

  it("katalog lengkap → 200 ready dengan 27 permission", async () => {
    const response = await fetch(`${BASE}/api/health/ready`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as ReadyBody;
    assert.equal(body.status, "ready");
    assert.equal(body.database, "up");
    assert.equal(body.permissionCatalog.expected, 27);
    assert.equal(body.permissionCatalog.actual, 27);
    assert.deepEqual(body.permissionCatalog.missing, []);
    assert.deepEqual(body.reasons, []);
  });

  it("katalog kosong → 503 not_ready yang menyebut katalog tidak lengkap", async () => {
    // SYSTEM: this test deliberately breaks platform-global seed state to simulate a
    // half-provisioned database; it is restored by the next test run's prepare step.
    await systemDb().rolePermission.deleteMany();
    await systemDb().permission.deleteMany();

    const response = await fetch(`${BASE}/api/health/ready`);
    assert.equal(response.status, 503);

    const body = (await response.json()) as ReadyBody;
    assert.equal(body.status, "not_ready");
    assert.equal(body.database, "up");
    assert.equal(body.permissionCatalog.actual, 0);
    assert.equal(body.permissionCatalog.expected, 27);
    assert.equal(body.permissionCatalog.missing.length, 27);
    assert.deepEqual(body.reasons, ["permission_catalog_incomplete"]);
  });

  it("setelah katalog di-seed ulang → 200 ready kembali", async () => {
    const { seedPermissionCatalog } = await import("@affiliateos/database");
    await seedPermissionCatalog();

    const response = await fetch(`${BASE}/api/health/ready`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as ReadyBody;
    assert.equal(body.status, "ready");
    assert.equal(body.permissionCatalog.actual, 27);
  });
});
