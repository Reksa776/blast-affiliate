// AffiliateOS — explicit MariaDB pool configuration.
//
// Why this file exists (F-6B-3): `new PrismaMariaDb(url)` leaves every pool option
// at the driver default, so each Node process opened connectionLimit = 10
// connections and kept them all open (measured 10 `Sleep` sessions in Checkpoint
// 6B.1). The pool is now sized and timed explicitly, from one place, for web and
// worker alike.
//
// Two facts from this host drive the numbers (Checkpoint 6C, read-only queries):
//   - MariaDB `max_connections = 151`; the account's `max_user_connections = 0`
//     (unlimited), so the only cap is the server-wide one.
//   - Server `time_zone = SYSTEM` and `SYSTEM` resolves to WIB (UTC+7). Session
//     time zone is therefore forced to UTC (`timezone: "Z"`) so that a
//     DATETIME(3) written by the app and one read by the app never disagree by
//     seven hours.
//
// Every process owns its own pool: web and worker each import this module and
// each get an independent pool. Nothing here is shared across processes.

/** The subset of `mariadb.PoolConfig` this project sets. All keys are optional in
 *  the driver's type, so this object is structurally assignable to it without
 *  importing `mariadb` (which is only a transitive dependency). */
export type MariaDbPoolOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  minimumIdle: number;
  acquireTimeout: number;
  connectTimeout: number;
  idleTimeout: number;
  timezone: string;
};

const DEFAULT_POOL_MAX = 5;
const DEFAULT_POOL_MIN_IDLE = 1;
const MIN_POOL_MAX = 1;
const MAX_POOL_MAX = 50;

/** 10s to obtain a connection from the pool — matches the driver default, kept
 *  explicit so it is reviewable rather than implicit. */
const ACQUIRE_TIMEOUT_MS = 10_000;
/** 10s to establish a new TCP/TLS connection. Loopback needs far less; a remote
 *  database or a proxy needs headroom. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Seconds. Must stay well below the server's `wait_timeout` (28800s here) so the
 *  client closes idle sockets before MariaDB drops them server-side. */
const IDLE_TIMEOUT_SECONDS = 600;

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_POOL_MAX || value > MAX_POOL_MAX) {
    // Name the variable, never echo the URL or any credential.
    throw new Error(
      `${name} must be an integer between ${MIN_POOL_MAX} and ${MAX_POOL_MAX}; received an invalid value.`,
    );
  }
  return value;
}

/**
 * Splits a `mysql://user:password@host:port/database` URL into pool options.
 *
 * The password is percent-decoded exactly once (URL parsing already decodes it;
 * `decodeURIComponent` is therefore applied to the raw component only through
 * `URL`, which handles `%40`, `%3A`, etc. correctly). Errors never include the
 * URL: it embeds the password.
 */
export function parseConnectionUrl(raw: string): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL. It must look like mysql://user:pass@host:3306/database.");
  }

  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mariadb:") {
    throw new Error(`DATABASE_URL must use the mysql:// scheme; received "${parsed.protocol}//".`);
  }

  const database = parsed.pathname.replace(/^\//, "");
  if (database === "") {
    throw new Error("DATABASE_URL does not name a database (the path component is empty).");
  }
  if (parsed.username === "") {
    throw new Error("DATABASE_URL does not name a database user.");
  }

  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

/**
 * Builds the pool options handed to `PrismaMariaDb`.
 *
 * Sizing (documented in docs/07-DATABASE-BASELINE-DESIGN.md §3):
 *   development:            web 5 + worker 3 = 8 connections worst case
 *   production, 1 instance: web 5 + worker 3 = 8, plus 1 migration job
 *   production, 2 instances: 2 × (5 + 3) = 16, plus 1 migration job
 * All are far below `max_connections = 151`, leaving room for admin sessions,
 * monitoring and a maintenance window.
 *
 * `minimumIdle` is deliberately 1 instead of the driver's fixed-pool default:
 * the pool opens connections on demand, keeps one warm, and releases extra
 * connections after `idleTimeout`, which is what F-6B-3 asked for.
 */
/**
 * Identity of a database account for separation checks: user@host:port.
 * The database name is excluded on purpose — the same account on the same server
 * is the same credential, whichever schema it opens.
 */
export function accountKey(rawUrl: string): string {
  const connection = parseConnectionUrl(rawUrl);
  return `${connection.user}@${connection.host}:${connection.port}`;
}

/**
 * Refuses to start the runtime when `MIGRATE_DATABASE_URL` names the same account
 * as `DATABASE_URL` (Checkpoint 6D, task 2). Using DDL credentials at runtime is
 * the exact failure this separation exists to prevent, so it is a startup error
 * rather than a warning. A missing variable is tolerated: the split is not
 * provisioned yet.
 */
export function assertSeparateAccounts(runtimeUrl: string, migrationUrl?: string): void {
  if (migrationUrl === undefined || migrationUrl.trim() === "") return;

  if (accountKey(runtimeUrl) === accountKey(migrationUrl)) {
    throw new Error(
      "DATABASE_URL and MIGRATE_DATABASE_URL resolve to the same database account. " +
        "The runtime must use the DML-only account; migrations must use the DDL account. " +
        "See docs/10-DATABASE-SECURITY-SEPARATION.md.",
    );
  }
}

export function buildPoolOptions(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): MariaDbPoolOptions {
  const connection = parseConnectionUrl(rawUrl);

  return {
    ...connection,
    connectionLimit: readInt(env, "DB_POOL_MAX", DEFAULT_POOL_MAX),
    minimumIdle: Math.min(
      readInt(env, "DB_POOL_MIN_IDLE", DEFAULT_POOL_MIN_IDLE),
      readInt(env, "DB_POOL_MAX", DEFAULT_POOL_MAX),
    ),
    acquireTimeout: ACQUIRE_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    timezone: "Z",
  };
}
