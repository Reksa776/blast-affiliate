-- =============================================================================
-- Task B — Per-table DML grants for `affiliateos_app`
-- =============================================================================
-- STATUS : DRAFT — NOT EXECUTED. Requires a login with GRANT OPTION (root via
--          unix socket). Every statement below is one line + semicolon so the
--          operator can review and run it with `sudo mariadb < this-file`.
--
-- SCOPE  : DML only, per table. NO `ON affiliateos.*` grant anywhere.
--          `audit_logs`, creator history/activity, campaign briefs/history get
--          SELECT, INSERT only (append-only).
--          `_prisma_migrations` gets nothing (Prisma-internal, migrate account
--          already owns it).
--          `affiliateos_migrate` is not touched.
--
-- WHY PER TABLE: MySQL/MariaDB has no DENY. `GRANT ... ON affiliateos.*` would
--          re-grant UPDATE/DELETE on audit_logs; table-level grants are the
--          only correct way to express append-only. See docs/10 §3.1.
--
-- WARNING (read before running block B)
--   `GRANT` to a host that does not exist CREATES that account with an EMPTY
--   password. Block B (`@'127.0.0.1'`) must be run ONLY if step 0 shows an
--   `affiliateos_app` row with host `127.0.0.1`. Connections from 127.0.0.1 on
--   this server authenticate as `affiliateos_app@localhost` (verified: the app
--   DSN uses host=127.0.0.1 and the server reports the session as @localhost),
--   so block A is the operative one.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 0 — PRE-FLIGHT (read-only; expect the values in comments)
-- -----------------------------------------------------------------------------
SELECT user, host FROM mysql.user WHERE user IN ('affiliateos_app', 'affiliateos_migrate');
-- expect: affiliateos_app@localhost, affiliateos_migrate@localhost
--         (a `127.0.0.1` row enables block B; absence means SKIP block B)

SELECT COUNT(*) AS base_tables
FROM information_schema.TABLES
WHERE table_schema = 'affiliateos' AND table_type = 'BASE TABLE';
-- expect after CRM and campaign migrations: 28 (27 business tables + _prisma_migrations)

SHOW GRANTS FOR 'affiliateos_app'@'localhost';
-- expect: exactly one line, `GRANT USAGE ON *.*`


-- -----------------------------------------------------------------------------
-- STEP 1 — BLOCK A: @'localhost' (22 business tables full DML + 4 append-only)
-- Generated from information_schema.tables, table_name <> 'audit_logs'
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`background_jobs` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`background_job_attempts` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`member_roles` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`permissions` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`platform_admin_grants` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`role_permissions` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`roles` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`sessions` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`users` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspace_invitations` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspace_members` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspaces` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creators` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_profiles` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_assignments` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT ON `affiliateos`.`creator_activities` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT ON `affiliateos`.`creator_status_histories` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_tags` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_tag_assignments` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_notes` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_blacklists` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`campaigns` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`campaign_creators` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT ON `affiliateos`.`campaign_contents` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`campaign_ad_codes` TO 'affiliateos_app'@'localhost';
GRANT SELECT, INSERT ON `affiliateos`.`campaign_status_histories` TO 'affiliateos_app'@'localhost';

-- audit_logs: append-only from the app's perspective
GRANT SELECT, INSERT ON `affiliateos`.`audit_logs` TO 'affiliateos_app'@'localhost';


-- -----------------------------------------------------------------------------
-- STEP 2 — BLOCK B: @'127.0.0.1'  (IDENTICAL LIST)
-- Run ONLY if STEP 0 showed an affiliateos_app@127.0.0.1 row.
-- Skipping it is safe; creating it accidentally is not (empty password).
-- -----------------------------------------------------------------------------
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`background_jobs` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`background_job_attempts` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`member_roles` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`permissions` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`platform_admin_grants` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`role_permissions` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`roles` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`sessions` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`users` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspace_invitations` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspace_members` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`workspaces` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creators` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_profiles` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_assignments` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT ON `affiliateos`.`creator_activities` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT ON `affiliateos`.`creator_status_histories` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_tags` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_tag_assignments` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_notes` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`creator_blacklists` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`campaigns` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`campaign_creators` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT ON `affiliateos`.`campaign_contents` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`campaign_ad_codes` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT ON `affiliateos`.`campaign_status_histories` TO 'affiliateos_app'@'127.0.0.1';
-- GRANT SELECT, INSERT ON `affiliateos`.`audit_logs` TO 'affiliateos_app'@'127.0.0.1';

FLUSH PRIVILEGES;


-- -----------------------------------------------------------------------------
-- STEP 3 — POST-CHECK (as admin): expect 27 table grants, NO `ON affiliateos.*`
-- -----------------------------------------------------------------------------
SHOW GRANTS FOR 'affiliateos_app'@'localhost';
SHOW GRANTS FOR 'affiliateos_migrate'@'localhost';
-- expect migrate: unchanged, 3 lines (USAGE + affiliateos.* + affiliateos_shadow.*)


-- -----------------------------------------------------------------------------
-- STEP 4 — DENIAL TESTS (run as affiliateos_app, not root)
-- -----------------------------------------------------------------------------
-- 4a. ordinary table: must SUCCEED
--   mariadb -u affiliateos_app -p -h 127.0.0.1 affiliateos -e "SELECT id FROM users LIMIT 1;"
--
-- 4b. audit_logs INSERT: must SUCCEED.
--     NOTE: the column list in the Task B prompt (`user_id`, no `actor_type`)
--     does not match this schema. Actual DDL:
--       id char(36) NOT NULL, tenant_id char(36) NULL,
--       actor_type enum('USER','WORKER','SYSTEM','SUPER_ADMIN') NOT NULL,
--       actor_user_id char(36) NULL, actor_member_id char(36) NULL,
--       action varchar(64) NOT NULL, resource_type varchar(64) NOT NULL,
--       resource_id char(36) NULL, request_id varchar(64) NULL,
--       ip_hash binary(32) NULL, user_agent varchar(255) NULL,
--       metadata json NULL, created_at datetime(3) NOT NULL DEFAULT now(3)
--   mariadb -u affiliateos_app -p -h 127.0.0.1 affiliateos -e "INSERT INTO audit_logs (id, tenant_id, actor_type, action, resource_type, resource_id) VALUES (UUID(), NULL, 'SYSTEM', 'taskB_probe', 'test', 'test_id');"
--
-- 4c. audit_logs UPDATE: must FAIL 1142
--   mariadb -u affiliateos_app -p -h 127.0.0.1 affiliateos -e "UPDATE audit_logs SET action='hacked' WHERE action='taskB_probe';"
--
-- 4d. audit_logs DELETE: must FAIL 1142
--   mariadb -u affiliateos_app -p -h 127.0.0.1 affiliateos -e "DELETE FROM audit_logs WHERE action='taskB_probe';"
--
-- 4e. DDL: must FAIL 1142/1044 (proves no schema-level DDL leaked in)
--   mariadb -u affiliateos_app -p -h 127.0.0.1 affiliateos -e "CREATE TABLE _probe (id INT);"
--
-- 4f. cleanup (as affiliateos_migrate)
--   mariadb -u affiliateos_migrate -p -h 127.0.0.1 affiliateos -e "DELETE FROM audit_logs WHERE action='taskB_probe';"


-- -----------------------------------------------------------------------------
-- ROLLBACK (only if a grant must be withdrawn)
-- -----------------------------------------------------------------------------
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`users` FROM 'affiliateos_app'@'localhost';
-- REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'affiliateos_app'@'localhost';
