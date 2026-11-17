// TEST SUPPORT ONLY — mutual exclusion for the shared test database.
//
// The database-touching suites truncate the same 13 tables in `affiliateos_test`,
// and one of them (`auth.test.ts`) needs a globally empty `users` table because
// registration is bootstrap-only. Node runs test *files* in parallel, so without
// coordination those suites destroy each other's fixtures — that is what the old
// `--test-concurrency=1` flag was hiding.
//
// This lock is per host and per test database (one file in the OS temp dir), so the
// files still run concurrently and only their database phases take turns. A crashed
// run cannot wedge the suite: a lock older than five minutes is considered stale.
//
// Longer term each suite should own a schema of its own (TD-7D-R1).

import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_PATH = join(tmpdir(), "affiliateos-test-db.lock");
const STALE_AFTER_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 100;

/** Waits for exclusive use of the test database and returns the release function. */
export async function acquireTestDbLock(timeoutMs = 180_000): Promise<() => void> {
  const startedAt = Date.now();

  for (;;) {
    try {
      closeSync(openSync(LOCK_PATH, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_AFTER_MS) unlinkSync(LOCK_PATH);
      } catch {
        // The lock disappeared between stat and unlink: retry immediately.
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for the test database lock.`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  return () => {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // Already released.
    }
  };
}
