// AffiliateOS — Prisma Client singleton (runtime side).
//
// Prisma 7 requires an explicit driver adapter; `new PrismaClient()` with no
// arguments is not supported (docs/06 §3.3). Pool sizing and timeouts are NOT
// left to the driver: `buildPoolOptions` supplies them explicitly (F-6B-3), and
// forces the session time zone to UTC so DATETIME(3) values stay unambiguous
// while MariaDB itself runs with `time_zone = SYSTEM` (WIB on this host).
//
// The client is memoised on globalThis so that Next.js dev hot-reload and worker
// restarts reuse one pool instead of opening a new one per module evaluation.

import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/prisma/client.js";
import { assertSeparateAccounts, buildPoolOptions } from "./pool.js";

const globalForPrisma = globalThis as unknown as { affiliateosPrisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;

  if (!url || url.trim() === "") {
    // Never echo the URL or any part of it: it embeds the password.
    throw new Error(
      "DATABASE_URL is not set. Load the repository .env explicitly before importing @affiliateos/database " +
        "(Prisma 7 does not do it for you).",
    );
  }

  // Checkpoint 6D: fail fast if the runtime was handed the migration credential.
  // No-op until MIGRATE_DATABASE_URL exists (the account split is not provisioned).
  assertSeparateAccounts(url, process.env.MIGRATE_DATABASE_URL);

  const adapter = new PrismaMariaDb(buildPoolOptions(url));
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.affiliateosPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.affiliateosPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
