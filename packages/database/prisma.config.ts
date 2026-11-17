// AffiliateOS — Prisma 7 configuration (CLI side).
//
// Prisma 7 does NOT read `.env` implicitly (proven in the Checkpoint 1 spike and
// recorded in docs/06-PRISMA-7-COMPATIBILITY-ADDENDUM.md §4). The environment is
// therefore loaded here, explicitly, before any variable is read.
//
// Loading order: walk up from this file's directory looking for the repository
// `.env`, stopping at the directory that owns the workspace file. Nothing is
// printed: the URL contains a password.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "prisma/config";

function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "package.json"))) {
      const manifest = readFileSync(join(current, "package.json"), "utf8");
      if (manifest.includes('"workspaces"')) return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("prisma.config.ts: could not locate the repository root (package.json with workspaces).");
}

const here = typeof import.meta.dirname === "string" ? import.meta.dirname : process.cwd();
const repoRoot = findRepoRoot(here);
const envFile = join(repoRoot, ".env");

if (existsSync(envFile)) {
  // Node's built-in .env parser (>= 20.12). No dotenv dependency, no implicit loading.
  process.loadEnvFile(envFile);
}

/** Fail loudly and by name instead of with a stack trace when a variable is missing. */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `prisma.config.ts: ${name} is not set. Prisma 7 does not load .env by itself; ` +
        `expected it in ${envFile} or in the process environment.`,
    );
  }
  return value;
}

/**
 * Migration URL. Checkpoint 6D: prefer the dedicated DDL account.
 *
 * The fallback to DATABASE_URL is transitional and must be deleted once
 * `affiliateos_migrate` exists (docs/10-DATABASE-SECURITY-SEPARATION.md). It is
 * kept so `validate`/`generate` still work in the current single-account state;
 * it never prints either URL.
 */
function migrationUrl(): string {
  const dedicated = process.env.MIGRATE_DATABASE_URL;
  if (dedicated !== undefined && dedicated.trim() !== "") return dedicated.trim();
  return required("DATABASE_URL");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: migrationUrl(),
    // Must point at a pre-created schema: no account here has CREATE DATABASE rights.
    shadowDatabaseUrl: required("SHADOW_DATABASE_URL"),
  },
});
