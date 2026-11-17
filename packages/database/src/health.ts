// AffiliateOS — the only read-only probe exported to the application.
//
// Checkpoint 6D (F-6C-6): `@affiliateos/database` no longer exports the raw
// PrismaClient. The health route needs one fixed statement, so it gets exactly
// that: `SELECT 1`. No table, no tenant data, no caller-supplied SQL, and nothing
// that could be reused as a general query channel.

import { prisma } from "./client.js";

type HealthRow = { health: unknown };

/**
 * Returns true when the database answered `SELECT 1`.
 *
 * The error is deliberately swallowed: driver errors can embed host, user and
 * connection options, and this boolean is all a liveness probe should reveal.
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<HealthRow[]>`SELECT 1 AS health`;
    return Number(rows[0]?.health) === 1;
  } catch {
    return false;
  }
}
