// AffiliateOS — structured logger with automatic redaction (P1 MEDIUM #5).
//
// One JSON object per line, ready for a collector (journald, Loki, CloudWatch).
// Two independent redaction passes:
//
//   1. keys: any key whose name contains a credential fragment (same list as
//      `sanitizeMetadata` in packages/database/src/audit.ts) becomes "[REDACTED]"
//      at every depth, including inside arrays;
//   2. values: strings that look like `password=…`, `token: …`, a cookie header or
//      `Bearer …` are masked too. That matters for error messages, where a driver
//      or a thrown Error can carry a secret in the *text* rather than in a field.
//
// Deliberately dependency-free: this module is imported by `handleRouteError`,
// which runs in the request path. Pulling in the database package (and therefore
// Prisma) just to reuse the fragment list would make logging a reason to open a
// pool. The list is duplicated with a pointer to the source of truth instead.
//
// Never throws: a logging failure must not turn a handled request into a 500.
// `console.log` is the sink on purpose — it is the one primitive every Node host
// already captures.

const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  "password",
  "passwd",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "csrf",
  "credential",
];

export const REDACTED = "[REDACTED]";

const MAX_DEPTH = 6;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 4000;

const TEXT_SECRET_PATTERN =
  /\b(password|passwd|token|secret|api[_-]?key|authorization|cookie|csrf)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function isForbiddenKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/** Masks credential-looking substrings inside free text (e.g. an Error message). */
export function redactText(value: string): string {
  return value
    .replace(TEXT_SECRET_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator}${REDACTED}`;
    })
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED_DEPTH]";
  if (value === null || value === undefined) return null;

  const type = typeof value;

  if (type === "string") {
    const text = value as string;
    const cut =
      text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]` : text;
    return redactText(cut);
  }
  if (type === "number") return Number.isFinite(value as number) ? value : null;
  if (type === "boolean") return value;
  if (type === "bigint") return (value as bigint).toString();
  if (type !== "object") return null;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  const record = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  let kept = 0;

  for (const [key, entry] of Object.entries(record)) {
    if (kept >= MAX_OBJECT_KEYS) {
      safe.__truncated_keys = true;
      break;
    }
    kept += 1;
    safe[key] = isForbiddenKey(key) ? REDACTED : redactValue(entry, depth + 1);
  }

  return safe;
}

/** Returns `data` with credential keys and credential-looking strings masked. */
export function redact(data?: Record<string, unknown> | null): Record<string, unknown> {
  if (data === null || data === undefined) return {};

  const sanitized = redactValue(data, 0);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

export type LogLevel = "info" | "warn" | "error";

/**
 * Emits one JSON line.
 *
 * Reserved fields are written last so a `data` key named `level` cannot rewrite
 * the level of the record (a spoofed log level is worse than a confusing one).
 */
export function log(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  const safe = redact(data);

  try {
    const record: Record<string, unknown> = { ts, level, event, ...safe };
    // Reserved fields win over a `data` object that happens to use the same names.
    record.level = level;
    record.event = event;
    console.log(JSON.stringify(record));
  } catch {
    // A circular structure or a hostile toJSON: emit the envelope only.
    console.log(JSON.stringify({ ts, level, event, log_error: "unserializable_data" }));
  }
}
