// AffiliateOS — explicit environment loading for NON-Next entrypoints.
//
// Prisma 7 and the MariaDB adapter do not read `.env` (docs/06 §4). Next.js has
// its own loader for apps/web; CLI scripts, the worker and integration tests use
// this helper and must call it BEFORE importing the Prisma client, because the
// client creates its pool at module-evaluation time.
//
// The walk stops only at a directory whose package.json declares workspaces, so a
// stray `.env` in a sub-package can never be picked up by accident.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function isWorkspaceRoot(dir: string): boolean {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    return readFileSync(manifestPath, "utf8").includes('"workspaces"');
  } catch {
    return false;
  }
}

/** Loads the repository `.env` and returns its path. Never returns its contents. */
export function loadRepoEnv(startDir: string = process.cwd()): string {
  let current = resolve(startDir);

  for (let depth = 0; depth < 8; depth += 1) {
    if (isWorkspaceRoot(current)) {
      const candidate = join(current, ".env");
      if (!existsSync(candidate)) {
        throw new Error(
          `Environment file missing: ${candidate}. Copy .env.example to .env (mode 600) and fill it locally.`,
        );
      }
      process.loadEnvFile(candidate);
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Could not locate a workspace root (package.json with "workspaces") above ${startDir}.`);
}

/** Reads a required variable, failing by name without revealing any URL. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is not set. Load the repository .env before using @affiliateos/database.`);
  }
  return value;
}
