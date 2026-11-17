// TEST SUPPORT ONLY — not imported by the application.
//
// Two entry points: `loadEnvForTests()` (load `.env` before the Prisma client is
// imported) and `requireTestDatabaseUrl()` (the integration suite's target, which
// has no development-database fallback).
//
// The auth tests talk to the real database, and the Prisma client reads
// `DATABASE_URL` at module-evaluation time. `npm test` is often run without a
// sourced shell, so the repository `.env` is loaded here first, using the same
// workspace-root walk as packages/database/src/env.ts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The integration tests must never run against the development database, so a
 * missing value is a hard failure rather than a silent fallback.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests refuse to run against the development database.",
    );
  }
  return url;
}

export function loadEnvForTests(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL.trim() !== "") return;

  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes('"workspaces"')) {
      const envFile = join(dir, ".env");
      if (existsSync(envFile)) process.loadEnvFile(envFile);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
