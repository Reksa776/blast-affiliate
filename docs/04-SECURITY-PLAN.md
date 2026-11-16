# 04 — SECURITY PLAN

> Phase 0 deliverable. Controls to implement from Phase 1 onward. Each control has
> a named verification method; a control is not "done" until that verification is
> recorded in a phase report.

---

## 1. Assets and Trust Boundaries

| Asset | Where it lives | Impact if compromised |
|---|---|---|
| Seller/creator access + refresh tokens | `tiktok_connections`, encrypted | Full control of a client shop's affiliate program |
| `app_secret` | server env only | Forge signed requests as our app |
| Password hashes | `users` | Account takeover |
| Session tokens | browser cookie (opaque), hash in DB | Impersonation within one user's grants |
| Tenant business data (creators, campaigns, GMV) | MariaDB | Competitor intelligence, reputational damage |
| Audit trail | `audit_logs` | Loss of accountability |
| Webhook endpoint | public HTTPS | Forged order/analytics data, forced deauthorization state |

Boundaries: browser ↔ web (untrusted), web ↔ MariaDB (trusted network), web ↔
Redis (trusted network), web/worker ↔ TikTok (untrusted upstream), TikTok →
webhook (untrusted inbound).

---

## 2. Threat Model (abbreviated STRIDE)

| Threat | Scenario | Primary controls |
|---|---|---|
| Spoofing | Stolen session cookie replayed | HttpOnly/Secure/SameSite, session rotation, idle+absolute expiry, IP-hash anomaly logging |
| Spoofing | Forged TikTok webhook | Constant-time HMAC over raw body, 401 on failure, no state change before verification |
| Tampering | Client-supplied `tenant_id` | Tenant resolved server-side from membership; body/query tenant ids ignored for authz |
| Tampering | Cross-tenant ID in URL | `not_found` for cross-tenant reads; composite FKs make cross-tenant writes impossible |
| Repudiation | "I didn't delete that campaign" | Append-only audit log with actor, before/after, request id |
| Information disclosure | List endpoint leaks another tenant's rows | Repository always filters `tenant_id`; attack test suite |
| Information disclosure | Token in log/error/URL | Central redaction, no token in query strings we control, no upstream bodies surfaced |
| Denial of service | Credential stuffing / API flood | Redis rate limits per IP+route and per user, login lockout, request size caps |
| Elevation of privilege | BD staff calls admin route | Server-side permission check per route, no client-side-only gating |
| Elevation of privilege | Worker job edited to another tenant | Payload validated against persisted job row and tenant membership |
| Supply chain | Malicious package | Exact versions, lockfile committed, `npm audit` reviewed, no postinstall surprises |
| Repudiation/abuse | Bulk outreach beyond quota | Quota checked server-side before enqueue and again before send; dedupe unique index |

Explicitly out of scope for a first release (documented, not silently ignored):
nation-state adversaries, physical access to the host, insider with DB root.

---

## 3. Control Specifications

### 3.1 Passwords
- **Argon2id** via `@node-rs/argon2` (prebuilt; avoids native compile on Node 26),
  parameters: `memoryCost = 19456 KiB (19 MiB)`, `timeCost = 2`, `parallelism = 1`
  (OWASP baseline), tuned in Phase 1 to ≤ 250 ms on this host.
- Minimum length 12, maximum 256 bytes; reject known-breached passwords only if a
  local list is bundled (no third-party call).
- Never log or email passwords. Password reset tokens: 32 random bytes, SHA-256 hash
  stored, 30-minute expiry, single use, invalidated on use or password change.
- Fallback if prebuilt binding is unavailable: `crypto.scrypt` with documented
  parameters — recorded as a deviation, not silently swapped.

### 3.2 Sessions
- Opaque token: 32 random bytes, base64url. Cookie name `__Host-aos_session`
  (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`).
- DB stores only `SHA-256(token)`; lookup by hash.
- Absolute lifetime 7 days; idle timeout 24 hours (`last_seen_at`); rotation on
  privilege change and on password change; full revoke-all-sessions action.
- Login regenerates the session id (fixation defence).
- No session data in `localStorage`, ever. No JWT in the browser.

### 3.3 Authorization (RBAC)
- Permission catalog in code (`packages/permissions/catalog.ts`), seeded to DB.
- Evaluation: `member → member_roles → role_permissions → permission key`, cached
  per request only.
- Route handler pattern: `requirePermission(ctx, 'campaign.publish')` throwing
  `forbidden`. There is no "UI hides the button" as a control.
- Deny by default: a route without an explicit permission declaration fails fast at
  startup in development and returns 403 in production (a test asserts every route
  under `/api` declares one).
- Role changes and permission grants require `team.manage` and are audited.

### 3.4 Tenant Isolation
Four layers as specified in `01-ARCHITECTURE.md` §5: branded `TenantContext`,
repository enforcement, composite FKs, attack tests. Additional rules:

- IDOR tests: for every resource type, an authenticated user of tenant A attempts
  `GET`, `PATCH`, `DELETE` and *assignment* operations against a tenant-B id. Expected:
  404 for reads/updates/deletes, 400/404 for assignment, and **no** mutation.
- Bulk endpoints validate every id belongs to the tenant before any write, and run
  the whole batch in one transaction.
- File/asset access is authorized by the owning record, never by a guessed path.
- Export endpoints (CSV) are tenant-scoped and audited; rate-limited.

### 3.5 CSRF
- Applicable because the session cookie is `SameSite=Lax` (not `Strict`, to keep
  OAuth redirects usable).
- For every unsafe method (`POST/PUT/PATCH/DELETE`): verify `Origin` (or `Referer`
  fallback) matches the configured app origin, **and** verify a double-submit token
  (`aos_csrf` cookie readable by JS + `X-CSRF-Token` header) bound to the session.
- Webhook route is exempt from CSRF (no cookie auth) and instead uses HMAC
  verification.

### 3.6 OAuth security
- `state`: 32 random bytes, base64url; stored **hashed** in `oauth_states` with
  tenant, user, intent, expiry ≤ 10 minutes, single use.
- Callback handler: consume state atomically (`UPDATE … WHERE consumed_at IS NULL`),
  verify it belongs to the current session user and tenant, then exchange the code.
- `redirect_path` (post-connect destination) must match an internal allowlist —
  prevents open redirect.
- `auth_code` is exchanged immediately (30-minute, single-use upstream rule).
- On token response: verify `code === 0`, expected `user_type`, and that
  `granted_scopes` ⊇ our minimum set. Missing required scope → connection marked
  `ERROR` with a user-visible reason, no partial activation.
- Tokens are never placed in a URL, a cookie, a job payload, or a client component.

### 3.7 Token encryption at rest
- AES-256-GCM. Key: 32 bytes from `TOKEN_ENCRYPTION_KEY` (base64), never committed.
- Envelope: `key_version (SMALLINT) | iv (12 bytes) | tag (16 bytes) | ciphertext`,
  stored in one `VARBINARY`.
- AAD: `tenantId || ':' || connectionId || ':' || fieldName` — prevents swapping
  ciphertexts between rows/tenants.
- Rotation: support N keys keyed by `key_version`; re-encrypt via a maintenance job.
- Decryption happens only inside the TikTok client, immediately before use;
  plaintext tokens are never assigned to long-lived objects or returned.
- Startup validation rejects a missing/malformed key in production (fail closed).

### 3.8 Request signing and upstream calls
- Sign the exact bytes sent (`01-ARCHITECTURE.md` §7); pure function with unit tests
  against the documented worked example.
- `timestamp` from a single clock source; if the host clock is unverifiable, log a
  warning at startup.
- Outbound timeout 15 s, max 2 retries for idempotent reads only, jittered backoff;
  no retry on auth, signature, quota (`16024049`), or validation errors.
- Response bodies are validated with Zod before use; unknown shapes are logged
  (redacted) and rejected rather than passed through.

### 3.9 Webhooks
- Verify HMAC over the raw body before parsing; `401` on failure; `200` empty body
  on success within 3 s (enqueue and return).
- No business mutation in the request path — persist to `webhook_events` and enqueue.
- Dedupe on `tts_notification_id` (unique index). At-least-once delivery is assumed.
- Payload is untrusted input: validate types, bound string lengths, never `eval`,
  never used to build SQL.

### 3.10 Input/output validation
- Zod at every boundary: route input, job payload, webhook body, upstream response,
  env vars.
- Unknown keys rejected (`.strict()`) on mutating endpoints.
- Pagination bounded (`page_size ≤ 100`), sort fields from an allowlist, no raw
  `orderBy` from user input.
- Output: React escapes by default; `dangerouslySetInnerHTML` forbidden by lint.
- CSV export: prefix cells beginning with `= + - @` to prevent spreadsheet formula
  injection; quote consistently.

### 3.11 Rate limiting and abuse
| Surface | Limit (initial, tunable) |
|---|---|
| Login | 5 failures / 15 min / IP+email, then exponential lockout |
| Password reset request | 3 / hour / email |
| Authenticated API (general) | 300 requests / min / user |
| Expensive list/export | 10 / min / user |
| Webhook ingress | 600 / min / IP (plus signature check) |
| OAuth callback | 20 / min / IP |
- Redis-backed token bucket; on Redis unavailability, fail **closed** for auth
  endpoints and log loudly.
- Every 429 includes `Retry-After` and is audited in aggregate (not per request).

### 3.12 Secure headers
`Content-Security-Policy` (no `unsafe-inline` for scripts; nonce-based),
`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY` + `frame-ancestors 'none'`,
`Permissions-Policy` minimal, `Cache-Control: no-store` on authenticated HTML/API.
No `X-Powered-By`.

### 3.13 Secrets management
- All secrets via environment variables; `.env*` git-ignored; `.env.example`
  contains names and descriptions only.
- Required-at-boot validation (Zod) — the app refuses to start with a missing or
  weak secret in production.
- Distinct secrets per environment; no production credentials in tests or fixtures.
- Rotation runbook for: `app_secret`, `TOKEN_ENCRYPTION_KEY`, session signing
  material (if any), DB passwords.
- No secret in Docker image layers, Compose files committed with values, or CI logs.

### 3.14 Database security
- Two accounts: `affiliateos_app` (DML only, no DDL) and `affiliateos_migrate`
  (DDL, used only by migrations). Neither is a superuser; neither has `FILE`,
  `PROCESS`, `SUPER`, or `GRANT OPTION`.
- MariaDB bound to internal interface; production Compose publishes no DB port.
- Parameterized queries only (Prisma); no string-built SQL.
- Least data selection: token columns excluded from generic selects.
- `LOCAL INFILE` disabled; `FILE` privilege absent.

### 3.15 Audit logging
Logged events (minimum): login success/failure, logout, session revoke, password
change, member invite/role change/removal, shop connect/disconnect/deauthorize,
creator create/delete/blacklist, assignment change, campaign create/publish/close,
outreach batch approve/send, export generation, permission/role edits, migration
execution marker.
Fields: `tenant_id`, actor (`user`/`system`/`worker`), action, entity type/id,
redacted before/after, request id, IP hash, user agent (truncated), timestamp.
Guarantees: append-only (no UPDATE/DELETE grant), survives entity deletion (no FKs),
written in the same transaction as the mutation where feasible.

### 3.16 Logging hygiene
Central redaction at the logger: keys and value patterns (`TTP_…`, `Bearer …`,
`sign=…`, `app_secret`), request URLs stripped of query strings for token endpoints,
and upstream bodies never logged wholesale. A unit test feeds known-secret-shaped
strings through the logger and asserts they do not appear in output.

### 3.17 Backup and recovery
- `mariadb-dump --single-transaction --routines --triggers --events` + gzip + age/GPG
  encryption, written off-host.
- Schedule: daily full, 7 daily / 4 weekly / 3 monthly retained; binlog-based PITR if
  the operator enables it (target RPO 1 h vs 24 h).
- **Restore verification is mandatory** before production: restore into a scratch
  schema, run a row-count + checksum comparison, and record the output. A backup that
  has never been restored is not a backup.
- Restore drill monthly in Phase 7 and thereafter.

### 3.18 Secure development process
- `.env*` and `*.pem` in `.gitignore` from the first commit.
- Pre-commit: typecheck + lint + secret scan (pattern-based, local).
- Dependency policy: exact versions, lockfile committed, `npm audit --omit=dev`
  reviewed each phase; no dependency added without a stated reason.
- Threat-model review whenever a new external boundary is added (e.g. outreach
  sending in Phase 5).
- Test credentials: generated fixture users only; never real shop tokens.

---

## 4. Verification Plan (per control)

| Control | Verification | Phase |
|---|---|---|
| Password hashing | Unit test: hash ≠ password, verify true/false, timing budget measured | 1 |
| Session security | Integration: cookie flags asserted on response; fixation test; expiry test | 1 |
| RBAC | Matrix test: every role × every protected route → expected allow/deny | 1 |
| Tenant isolation | Attack suite: cross-tenant read/update/delete/assign for each P1 entity | 1, extended each phase |
| CSRF | Test: unsafe request without token → 403; wrong Origin → 403 | 1 |
| OAuth state | Test: reuse → reject; expired → reject; other user's state → reject | 2 |
| Token encryption | Test: ciphertext ≠ plaintext, AAD swap fails, rotation round-trip | 2 |
| Signing | Unit test against the documented worked example; body-bytes test | 2 |
| Webhooks | Test: valid sig 200, tampered body 401, duplicate id deduped | 2 |
| Rate limiting | Test: N+1 request → 429 with `Retry-After` | 1 |
| Headers | Test: assert each header on HTML and API responses | 1 |
| Redaction | Unit test: seeded secret never appears in log output | 1 |
| Audit | Test: mutation produces exactly one audit row with actor/tenant | 1 |
| Backups | Phase 7: restore into scratch DB, checksum comparison recorded | 7 |
| CSV injection | Unit test: leading `=`/`+`/`-`/`@` escaped | 6 |

---

## 5. Known Security Constraints of This Project

1. **No WAF/CDN assumed.** Nginx rate limiting + app-level limits are the only
   perimeter controls.
2. **TikTok token endpoint requires `app_secret` in a query string.** We cannot change
   that; we mitigate with server-only calls and URL redaction.
3. **Affiliate outreach is externally capped by TikTok quota.** Application-side
   enforcement must mirror upstream rules, and must not become a bypass by retrying
   after `16024049`.
4. **Webhook replay protection is limited** — TikTok's signature does not include a
   timestamp, so dedupe plus reconciliation polling is required.
5. **No MFA in Phase 1.** TOTP is a candidate for Phase 7; until then, strong
   passwords, lockout, and session revocation are the compensating controls, and this
   gap is stated rather than hidden.
