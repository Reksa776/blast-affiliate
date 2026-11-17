// AffiliateOS — worker process (placeholder).
//
// P1.1 scope: prove the process can start, reach the database, keep itself alive
// and shut down on SIGTERM/SIGINT. No queue, no job handlers — BullMQ arrives in
// P1.3. Two things here are deliberate and will survive that change:
//
//  1. Structured logs (one JSON object per line). A log collector can parse this
//     without a regex, and the terminal stays readable because each line is short.
//  2. The database is imported AFTER `.env` is loaded. `@affiliateos/database`
//     creates its pool at module-evaluation time and throws when DATABASE_URL is
//     missing (packages/database/src/client.ts), so a static import here would
//     require every caller to pre-export the environment. The worker instead
//     resolves the repo `.env` itself and then dynamic-imports the package, which
//     means `node dist/index.js` works on its own — no wrapper script.
//
// Health is a fixed `SELECT 1`, not a query of business tables: the worker is
// cross-tenant infrastructure, and a probe must never read tenant data.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const HEALTH_INTERVAL_MS = 30_000;
/** Upper bound for one probe. The driver's own connect/acquire timeout is 10s; a
 *  liveness probe must answer sooner than that or the log stays silent. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long shutdown waits for a probe that is already in flight. */
const PROBE_SHUTDOWN_GRACE_MS = 1_500;
/** Upper bound for closing the pool during shutdown. */
const DISCONNECT_TIMEOUT_MS = 3_000;
/** Last resort if any of the bounded steps above still hangs. */
const SHUTDOWN_TIMEOUT_MS = 6_000;

type LogFields = Record<string, unknown>;

/** A wait that exceeded its own budget, as opposed to a driver error. */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Resolves with `promise`, or rejects with TimeoutError after `ms`.
 *
 * Needed because an unreachable database does not fail fast: the pool waits for its
 * connect/acquire timeout, which is longer than a probe — or a shutdown — should
 * ever block for.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function log(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * Walks up to the repository root (the package.json that declares `workspaces`)
 * and loads its `.env`. Same rule as next.config.ts and prisma.config.ts: one
 * environment file for the whole monorepo, never a copy per app.
 *
 * Variables already present in the process environment win — `process.loadEnvFile`
 * does not overwrite them, so a deployment can inject DATABASE_URL without a file.
 */
function loadRepoEnv(startDir: string = process.cwd()): void {
  let current = resolve(startDir);

  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      let manifest = "";
      try {
        manifest = readFileSync(manifestPath, "utf8");
      } catch {
        manifest = "";
      }
      if (manifest.includes('"workspaces"')) {
        const envFile = join(current, ".env");
        if (existsSync(envFile)) process.loadEnvFile(envFile);
        return;
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

loadRepoEnv();

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
  // Name the variable, never a value: the URL embeds the password.
  log("error", "config_error", { reason: "DATABASE_URL is not set (looked in process env and the repo .env)" });
  process.exit(1);
}

// Imported after the environment exists: the package builds its connection pool
// at module evaluation, so this order is required, not stylistic.
const { disconnectPrisma, systemDb } = await import("@affiliateos/database");

let shuttingDown = false;
let healthTimer: NodeJS.Timeout | undefined;
/** In-flight probe, so shutdown can wait for it (briefly) instead of racing it. */
let probeInFlight: Promise<void> | undefined;
/** Prevents an interval tick from starting a second probe while one is stuck. */
let probeRunning = false;

async function healthCheck(): Promise<void> {
  try {
    const rows = await withTimeout(
      systemDb().$queryRaw<Array<{ ok: unknown }>>`SELECT 1 AS ok`,
      PROBE_TIMEOUT_MS,
      "health probe",
    );
    if (Number(rows[0]?.ok) === 1) {
      // SYSTEM: worker liveness probe; cross-tenant by nature, reads no tenant row.
      log("info", "health_ok", { db: "ok" });
    } else {
      log("error", "health_fail", { reason: "unexpected_result" });
    }
  } catch (error) {
    // A failed probe is not a crash: the next interval retries, and a worker that
    // restarts on every database blip would be worse than one that waits.
    log("error", "health_fail", {
      reason: error instanceof TimeoutError ? "timeout" : "query_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function runHealthCheck(): void {
  if (probeRunning) return;
  probeRunning = true;
  probeInFlight = healthCheck().finally(() => {
    probeRunning = false;
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log("warn", "shutdown_already_in_progress", { signal });
    return;
  }
  shuttingDown = true;
  log("info", "shutdown_start", { signal });

  if (healthTimer !== undefined) clearInterval(healthTimer);

  // Never let a hung pool block the process supervisor: force the exit if the
  // graceful path takes too long. `unref` keeps this timer from holding the
  // process open on its own.
  const forceExit = setTimeout(() => {
    log("error", "shutdown_forced", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
    // The steps above are individually bounded, so reaching this means something
    // escaped every budget — a real defect, reported as a non-zero exit.
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Abandon (do not wait forever for) a probe that is still blocked on an
  // unreachable database: a stop signal must complete, not time out.
  if (probeInFlight !== undefined) {
    try {
      await withTimeout(probeInFlight, PROBE_SHUTDOWN_GRACE_MS, "pending health probe");
    } catch {
      log("warn", "shutdown_probe_abandoned", { signal, graceMs: PROBE_SHUTDOWN_GRACE_MS });
    }
  }

  try {
    await withTimeout(disconnectPrisma(), DISCONNECT_TIMEOUT_MS, "database disconnect");
    log("info", "shutdown_db_disconnected", { signal });
  } catch (error) {
    log("error", "shutdown_db_error", { error: error instanceof Error ? error.message : String(error) });
  }

  clearTimeout(forceExit);
  log("info", "shutdown_complete", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  log("error", "uncaught_exception", { error: error.message });
  process.exit(1);
});

log("info", "worker_started", { note: "placeholder, BullMQ di P1.3", pid: process.pid });

runHealthCheck();
healthTimer = setInterval(runHealthCheck, HEALTH_INTERVAL_MS);
