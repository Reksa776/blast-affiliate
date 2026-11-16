# 00 — PROJECT BASELINE

> Phase 0 deliverable. Captured 2026-11-16 on the development workstation.
> Every statement below is either a command output captured in this session or is
> explicitly labelled as an assumption, a risk, or unverified.

---

## 1. Purpose

Establish the factual starting point for AffiliateOS before any code exists:

- what is in the repository,
- what the host can actually run,
- which external dependencies are reachable,
- which facts about the TikTok Shop APIs are verified and which are not,
- what constraints shape Phase 1.

No application source code, dependency install, service start, schema change, or
Git operation was performed in Phase 0. Only this `docs/` directory was created.

---

## 2. Repository State

| Check | Command | Result |
|---|---|---|
| Working directory | `pwd` | `/home/reksa/affiliateos` |
| Directory contents | `ls -la` | Empty — only `.` and `..` |
| Git repository | `git status` | `fatal: not a git repository (or any of the parent directories): .git` |
| Branch | `git branch -a` | Not applicable — no repository |
| Commit history | `git log --oneline -10` | Not applicable — no repository |
| Existing source | — | None |
| Existing dependencies | — | No `package.json`, no lockfile, no `node_modules` |
| Existing CI | — | None |
| Existing docs | — | None (this directory is new) |

**Conclusion:** greenfield. There is no pre-existing code to preserve, no
uncommitted work to protect, and no history to rewrite. The Phase 0 checkpoint
requirement "inspect Git status / branch / commit" is satisfied by recording that
no repository exists. `git init` is a Phase 1 action and requires approval (it is
a repository mutation, and the instruction forbids automatic Git actions).

---

## 3. Host Baseline

| Property | Evidence | Value |
|---|---|---|
| OS | `uname -a`, `/etc/os-release` | Debian GNU/Linux 13 (trixie), kernel 6.12.116+deb13-amd64, x86_64 |
| CPU cores | `nproc` | 8 |
| RAM | `free -h` | 7.0 GiB total, 3.8 GiB used, **3.2 GiB available** |
| Swap | `free -h` | 7.5 GiB, unused |
| Disk | `df -h .` | 100 G total, 30 G used, **66 G available** (32% used) |
| Node.js | `node --version` | **v26.13.0** |
| npm | `npm --version` | 11.20.0 |
| pnpm | `pnpm --version` | not installed |
| yarn | `yarn --version` | not installed |
| Git | `git --version` | 2.47.3 |
| Docker | `docker --version` / `docker compose version` | **not installed** |
| sudo | `sudo -n true` | password required — **no non-interactive privilege escalation** |

### 3.1 Resource interpretation

3.2 GiB available RAM with no GPU is the binding constraint on this workstation.
Consequences written into the roadmap:

- Run **one** Next.js dev server, **one** worker, and no production build at the
  same time as a test suite.
- Keep worker concurrency at 1–2 in development (`WORKER_CONCURRENCY=2`).
- Do not run MariaDB and Redis inside Docker *and* natively.
- `next build` should be run in isolation (it is the single heaviest step), not in
  parallel with Playwright or Vitest.
- Playwright browser download (~300 MB) and run are acceptable on 66 G free disk
  but should be limited to Chromium.

---

## 4. Service Availability

### 4.1 MariaDB — INSTALLED AND RUNNING, ACCESS NOT YET PROVEN

```
$ systemctl is-active mariadb      -> active
$ systemctl is-enabled mariadb     -> enabled
$ ss -lntp | grep 3306             -> LISTEN 127.0.0.1:3306
$ mariadb --version                -> mysql from 11.8.6-MariaDB, client 15.2
$ mariadb -u root -e "SELECT VERSION()"
ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: NO)
$ mariadb -u reksa -e "SELECT 1"
ERROR 1698 (28000): Access denied for user 'reksa'@'localhost'
```

- Version 11.8.6 satisfies the MariaDB 11.8+ requirement.
- It listens on `127.0.0.1` only — not exposed publicly, which matches the
  security requirement.
- **No application account or application database exists yet.** `root` uses
  socket/`unix_socket` authentication, so creating the AffiliateOS database and a
  least-privilege user requires either an existing MariaDB login or `sudo`.
  Both are currently unavailable non-interactively → **inventory: PARTIALLY
  VERIFIED / provisioning BLOCKED pending credentials**.
- Server flags (`sql_mode`, `character_set_server`, `default_storage_engine`) could
  **not** be read, so the InnoDB/utf8mb4 server defaults are not yet verified — only
  the client version is.

### 4.2 Redis — NOT INSTALLED

```
$ which redis-server redis-cli   -> (no output)
$ redis-cli --version            -> bash: redis-cli: command not found
$ ss -lntp | grep 6379           -> (no listener)
$ dpkg -l | grep -i redis        -> (no redis packages)
```

Redis is a hard prerequisite for BullMQ. Installing it requires system package
privileges (`sudo`), which are not available non-interactively. **BLOCKED** until
the operator installs Redis or grants a container runtime.

### 4.3 Docker — NOT INSTALLED

`docker` and `docker compose` are both absent. The required deployment
(Docker Compose) therefore cannot be exercised on this workstation today.
**BLOCKED** for local Compose validation; the Compose files can still be authored
and reviewed in Phase 1, clearly marked as unexecuted.

### 4.4 Network listeners observed

```
LISTEN 127.0.0.1:3306     MariaDB
LISTEN 0.0.0.0:80         (existing web server, purpose unknown — not touched)
LISTEN 0.0.0.0:7070       (unknown service — not touched)
LISTEN 127.0.0.1:631      CUPS
LISTEN tailscale0:52889 / :36915   Tailscale
```

Ports 80 and 7070 are occupied by services outside this project. Phase 1 must
choose a free dev port (3000/3001/8080) and must not stop these processes.

### 4.5 Outbound network

| Target | Method | Result |
|---|---|---|
| `registry.npmjs.org` | `curl -o /dev/null -w %{http_code}` | `200` |
| `npm ping` | npm | `PONG 269ms` |
| `partner.tiktokshop.com` | `curl` | `200` |
| `developers.tiktok.com` | `curl` | `200` |

npm is usable. TikTok documentation hosts are reachable, but the Partner Center
pages are **client-side rendered**: `read_url` returned only the navigation shell
(`TikTok Shop Partner Center / Documentation / Contact Us / Log in / Documents /
FAQs / API Testing Tool`). Technical detail in
`03-TIKTOK-API-CAPABILITY-MATRIX.md` therefore comes from indexed page text
served by the search index, not from a rendered page. This distinction matters and
is recorded there as a verification-method caveat.

---

## 5. Package Registry Snapshot (informational)

`npm view <pkg> version`, captured 2026-11-16. **Not installed, not endorsed yet.**

| Package | Latest | Note |
|---|---|---|
| next | 16.4.6 | App Router target |
| react | 19.3.1 | matches Next 16 |
| prisma (CLI) | 8.0.0-rc.33 | **prerelease** — do not adopt |
| @prisma/client | 7.10.1 | pin CLI to the matching 7.x line |
| bullmq | 6.7.6 | requires Redis |
| ioredis | 6.0.0 | BullMQ peer |
| zod | 4.6.7 | v4 API differs from v3 examples online |
| next-auth | 4.24.15 | v4 line; auth strategy decision in `01-ARCHITECTURE.md` |
| typescript | 7.0.2 | native-port major; Next/Prisma tooling compatibility unverified |
| vitest | 5.1.0 | unit/integration runner |
| @playwright/test | 1.65.1 | E2E |
| tailwindcss | 4.3.5 | v4 config is CSS-first, differs from v3 docs |

**Pin exact versions in Phase 1 after a smoke test.** "Latest" is not a
compatibility guarantee, and two of these majors (TypeScript 7, Tailwind 4) have
breaking configuration models relative to most online examples.

---

## 6. Constraints Carried Into Phase 1

1. **No Redis, no Docker, no DB credentials.** Phase 1 must either obtain these or
   implement and verify everything that does not require them (repository layout,
   TypeScript config, schema authoring, pure business logic, unit tests).
2. **Memory ceiling.** No parallel heavy processes. Production build is a separate,
   isolated step.
3. **Node 26.13.0 is newer than most published support matrices.** Next 16 and
   Prisma 7 must be smoke-tested on it. Fallback: Node 24 LTS via a local version
   manager (a system-level change → requires approval).
4. **No non-interactive sudo.** Any `apt install`, service definition, or
   system-level configuration is an operator action.
5. **Existing services on ports 80/7070 must not be disturbed.**
6. **No TikTok app credentials.** Every live API capability stays BLOCKED;
   development proceeds against interfaces + mocks labelled as mocks.

---

## 7. Assumptions (explicit, revisitable)

| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | The company has, or can obtain, a TikTok Shop Partner Center developer account eligible for the Indonesian market. | The entire TikTok integration layer stays mock-only; CRM/analytics must stand on manual/CSV data. |
| A2 | The platform will be operated by an internal agency for multiple client shops initially, not as public SaaS. | Auth/tenant model would need public registration, billing, and stronger abuse controls earlier. |
| A3 | Indonesian shops authorize the app via **seller** authorization (`user_type = 0`); creators are not expected to authorize individually. | Creator-authorized capabilities (`creator.*` scopes) would become available, changing Phase 3/6 scope. |
| A4 | MariaDB and Redis may be installed natively on the host or in Docker by the operator. | Development is limited to code + unit tests until the operator acts. |
| A5 | Indonesian rupiah amounts fit `DECIMAL(18,2)` and commissions are expressed as basis points. | Rate precision assumptions in analytics change. |

---

## 8. Baseline Status

| Area | Status | Reason |
|---|---|---|
| Repository inspection | **PASS** | Directory empty, no Git repository, confirmed by command output |
| Runtime toolchain inventory | **PASS** | Node, npm, Git, MariaDB client/server versions captured |
| MariaDB availability | **PARTIALLY VERIFIED** | Server active on 127.0.0.1:3306, v11.8.6; no usable account, server defaults unread |
| Redis availability | **BLOCKED** | Not installed, no listener, install needs privileges |
| Docker availability | **BLOCKED** | Not installed |
| TikTok documentation access | **PARTIALLY VERIFIED** | Hosts reachable; Partner Center pages client-rendered, detail from indexed page text |
| TikTok credentials / app approval | **BLOCKED** | No Partner Center app, no credentials, no scope approval |
| Application code | **NOT STARTED (by design)** | Phase 0 forbids feature implementation |

**Phase 0 overall: PARTIALLY VERIFIED.** See `PHASE-0-REPORT.md`.
