// AffiliateOS — audit writer (P0.7).
//
// `audit_logs` is append-only in two independent layers:
//
//   1. database: `affiliateos_app` holds SELECT and INSERT on the table and nothing
//      else, so UPDATE/DELETE fail with ER_TABLEACCESS_DENIED_ERROR (1142) even if
//      application code asks for them (docs/sql/0002-p0.3-per-table-grants.sql);
//   2. application: `withTenant()` refuses update/delete on AuditLog before the
//      query is sent (packages/database/src/tenant-db.ts), so the normal request
//      path cannot even form the statement.
//
// This module is the only supported writer, and it only ever inserts.
//
// What it guarantees, and why each guarantee exists:
//   - the client IP is stored as SHA-256, never plaintext (`ip_hash` is BINARY(32));
//   - metadata is sanitised: any key whose name suggests a credential is replaced
//     by "[REDACTED]" at every nesting depth, including inside arrays, so a future
//     caller cannot leak a password or token through a nested object;
//   - `action`/`resourceType` longer than their columns throw instead of being
//     silently truncated — a truncated audit action is a lost audit record.
//
// Tenant scoping: `audit_logs.tenant_id` is nullable because platform-level events
// (login, logout, bootstrap registration) have no workspace. Writes go through
// `systemDb()` for that reason, marked SYSTEM at the call site.

import crypto from "node:crypto";

import { Prisma } from "./generated/prisma/client.js";
import { systemDb } from "./tenant-db.js";

export const AUDIT_ACTION_MAX_LENGTH = 64;
export const AUDIT_RESOURCE_TYPE_MAX_LENGTH = 64;
export const AUDIT_REQUEST_ID_MAX_LENGTH = 64;
export const AUDIT_USER_AGENT_MAX_LENGTH = 255;
export const REDACTED = "[REDACTED]";

/**
 * A key is treated as a credential when its name contains one of these fragments,
 * case-insensitively. Deliberately broad: over-redacting an audit field costs a
 * little diagnosis, under-redacting leaks a secret into a table that cannot be
 * cleaned (append-only).
 */
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

/** Deepest metadata nesting that is preserved; anything deeper becomes a marker. */
const MAX_METADATA_DEPTH = 6;

/** Per-object key cap, so one metadata blob cannot become unbounded. */
const MAX_OBJECT_KEYS = 100;

/** Longest string kept inside metadata. */
const MAX_METADATA_STRING = 2000;

export type AuditActorType = "USER" | "WORKER" | "SYSTEM" | "SUPER_ADMIN";

export class AuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditInputError";
  }
}

export interface WriteAuditInput {
  /** null for platform-level events that have no resolved workspace. */
  tenantId: string | null;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorMemberId?: string | null;
  /** `domain.verb`, e.g. `auth.login`, `workspace.create`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  /** Hashed before storage; the plaintext IP never reaches the database. */
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function isForbiddenMetadataKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_METADATA_DEPTH) return "[TRUNCATED_DEPTH]";

  if (value === null || value === undefined) return null;

  const type = typeof value;
  if (type === "string") {
    const text = value as string;
    return text.length > MAX_METADATA_STRING ? `${text.slice(0, MAX_METADATA_STRING)}…[TRUNCATED]` : text;
  }
  if (type === "number") return Number.isFinite(value as number) ? value : null;
  if (type === "boolean") return value;
  if (type === "bigint") return (value as bigint).toString();
  // Functions, symbols and other non-JSON values are dropped rather than stringified:
  // `[Function]` in an audit row is noise, not evidence.
  if (type !== "object") return null;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, depth + 1));
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

    safe[key] = isForbiddenMetadataKey(key) ? REDACTED : sanitizeValue(entry, depth + 1);
  }

  return safe;
}

/**
 * Returns metadata safe to persist: credential-looking keys redacted at every
 * depth, arrays preserved, undefined/function values dropped.
 */
export function sanitizeMetadata(meta?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (meta === null || meta === undefined) return null;

  const sanitized = sanitizeValue(meta, 0);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : null;
}

function hashIp(ip: string): Uint8Array<ArrayBuffer> {
  // Prisma 7 types a Bytes column as Uint8Array<ArrayBuffer>; a Buffer digest is
  // backed by ArrayBufferLike, so the 32 bytes are copied into a fresh view.
  return new Uint8Array(crypto.createHash("sha256").update(ip, "utf8").digest());
}

function assertFits(value: string, max: number, field: string): string {
  if (value.length > max) {
    throw new AuditInputError(`Audit ${field} exceeds ${max} characters.`);
  }
  return value;
}

/**
 * Appends one audit row and returns its id.
 *
 * Throws on invalid input rather than writing a degraded record. A failed insert
 * propagates to the caller: for security events, losing the audit line silently is
 * worse than failing the request.
 */
export async function writeAudit(input: WriteAuditInput): Promise<string> {
  const action = assertFits(input.action, AUDIT_ACTION_MAX_LENGTH, "action");
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(action)) {
    throw new AuditInputError("Audit action must look like `domain.verb` in lowercase.");
  }

  const resourceType = assertFits(input.resourceType, AUDIT_RESOURCE_TYPE_MAX_LENGTH, "resourceType");
  const requestId =
    input.requestId === null || input.requestId === undefined
      ? null
      : assertFits(input.requestId, AUDIT_REQUEST_ID_MAX_LENGTH, "requestId");

  const id = crypto.randomUUID();
  const safeMetadata = sanitizeMetadata(input.metadata);

  // SYSTEM: the audit trail is platform-wide, spans tenants, and must be writable
  // before (or without) a tenant context — e.g. a failed login.
  await systemDb().auditLog.create({
    data: {
      id,
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      actorMemberId: input.actorMemberId ?? null,
      action,
      resourceType,
      resourceId: input.resourceId ?? null,
      requestId,
      ipHash: input.ip === null || input.ip === undefined || input.ip === "" ? null : hashIp(input.ip),
      // Browser UA strings are long by nature; a suffix loss is acceptable here,
      // unlike a truncated action.
      userAgent:
        input.userAgent === null || input.userAgent === undefined || input.userAgent === ""
          ? null
          : input.userAgent.slice(0, AUDIT_USER_AGENT_MAX_LENGTH),
      // `null` alone would mean JSON null to Prisma; DbNull is the SQL NULL that
      // "no metadata" actually is (and what T7 reads back).
      metadata: safeMetadata === null ? Prisma.DbNull : (safeMetadata as Prisma.InputJsonValue),
    },
    select: { id: true },
  });

  return id;
}
