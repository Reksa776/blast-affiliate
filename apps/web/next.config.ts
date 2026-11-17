// AffiliateOS — Next.js configuration.
//
// ENVIRONMENT (fix for F-6A-4):
// Next.js loads `.env` from the app directory (`apps/web`), but this project keeps
// a single root `.env`. Relying on Next's implicit lookup would therefore be
// silently wrong. The root file is loaded here, explicitly, with Node's built-in
// parser (no dotenv dependency), before any server code runs.
//
// Precedence: values already present in the process environment win, because
// `process.loadEnvFile` does not overwrite existing variables. That keeps CI and
// production able to inject `DATABASE_URL` without the file, and means no
// credential is ever duplicated into `apps/web`.
//
// Nothing from here is exposed to the browser: `DATABASE_URL` is never prefixed
// with NEXT_PUBLIC_, and `env` in next.config is deliberately NOT used.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NextConfig } from "next";

function isWorkspaceRoot(dir: string): boolean {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    return readFileSync(manifestPath, "utf8").includes('"workspaces"');
  } catch {
    return false;
  }
}

function findWorkspaceRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (isWorkspaceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("next.config.ts: could not locate the workspace root (package.json with workspaces).");
}

function loadRootEnv(): void {
  const root = findWorkspaceRoot(process.cwd());
  const envFile = join(root, ".env");

  if (existsSync(envFile)) {
    // Does not override variables already set in the process environment.
    process.loadEnvFile(envFile);
  }

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
    // Fail at build/start instead of at the first request. Never print the value.
    throw new Error(
      `Next.js requires DATABASE_URL. It is not set in the process environment and ` +
        `${envFile} could not provide it. See .env.example for the expected names.`,
    );
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep the database stack out of the bundler: the MariaDB driver uses dynamic
  // requires and must run as a normal Node module on the server.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-mariadb", "mariadb"],
};

export default nextConfig;
