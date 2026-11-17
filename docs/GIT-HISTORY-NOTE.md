# Git History Note

Commit 4f3979c "first commit" (2026-11-17) menggabungkan tiga workstream:

1. 8B (Buildfix + Security Headers) — proxy.ts, security-headers.ts, build:worker
2. 8C (Session Policy) — session.ts, cookie-name.ts, TTL 7d, idle 24h, __Host- cookie
3. Phase 2 (Office Settings + UI + Rate Limit) — schema + migration p2_office_settings, office settings API/UI, accept-invitation, rate limit per-user

Kenapa digabung: ketiganya ada di working tree bersamaan tanpa commit terpisah. Commit ini menerima kondisi itu tanpa rewrite history (sudah di-push ke origin/main).

Verifikasi:
- Test: database 46 pass, web 283 pass
- Typecheck: exit 0
- Audit independen: docs/AUDIT-PHASE-1-2026-11-17.md
- Tag: checkpoint-8b-8c-p2-combined
