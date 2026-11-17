-- DRAFT ONLY — NOT EXECUTED — REQUIRES EXPLICIT APPROVAL
-- AffiliateOS — P0.2 account separation (runbook draft)
--
-- Replace <APP_PASSWORD> and <MIGRATE_PASSWORD> with locally generated values.
-- Suggested generation (run locally, never paste the output into chat or Git):
--   openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
--
-- Run as a MariaDB administrator (socket root / sudo mariadb). Operator action.
-- Two accounts only, per the P0.2 instruction. docs/10 §2 recommends a third
-- (affiliateos_shadow) for shadow isolation; that is deliberately NOT created here
-- and is recorded as a known limitation.

-- ---------------------------------------------------------------------------
-- 1. Accounts — both host forms, because the app connects over TCP to 127.0.0.1
--    while MariaDB also resolves the socket as 'localhost'.
--    If an account already exists, use ALTER USER ... IDENTIFIED BY instead;
--    CREATE USER IF NOT EXISTS would silently keep the old password.
-- ---------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'affiliateos_app'@'127.0.0.1'     IDENTIFIED BY '1XMkJzQHGY7fvhhAnyTVqwgpU2uBouwR';
CREATE USER IF NOT EXISTS 'affiliateos_app'@'localhost'     IDENTIFIED BY '1XMkJzQHGY7fvhhAnyTVqwgpU2uBouwR';
CREATE USER IF NOT EXISTS 'affiliateos_migrate'@'127.0.0.1' IDENTIFIED BY 'nJwyGBPthwqTAzZqQoFE2t60pATST6yA';
CREATE USER IF NOT EXISTS 'affiliateos_migrate'@'localhost' IDENTIFIED BY 'nJwyGBPthwqTAzZqQoFE2t60pATST6yA';

-- ---------------------------------------------------------------------------
-- 2. Migration account — explicit DDL + DML (docs/10 §3.2).
--    No ALL PRIVILEGES, no global privilege, no GRANT OPTION.
--    It needs the shadow schema only because shadowDatabaseUrl uses the same CLI
--    config (two-account decision).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `affiliateos`.* TO 'affiliateos_migrate'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `affiliateos`.* TO 'affiliateos_migrate'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `affiliateos_shadow`.* TO 'affiliateos_migrate'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES
  ON `affiliateos_shadow`.* TO 'affiliateos_migrate'@'localhost';

-- ---------------------------------------------------------------------------
-- 3. App account — NO grant yet (fail-closed until the tables exist).
--    A schema-wide GRANT would re-open audit_logs, and MySQL/MariaDB cannot
--    subtract it with a table-level REVOKE. Per-table grants are generated
--    AFTER M1 is applied:
--
--    SELECT CONCAT('GRANT SELECT, INSERT, UPDATE, DELETE ON `affiliateos`.`',
--                  table_name, '` TO ''affiliateos_app''@''127.0.0.1'';')
--    FROM information_schema.tables
--    WHERE table_schema='affiliateos' AND table_type='BASE TABLE'
--      AND table_name <> 'audit_logs';
--
--    GRANT SELECT, INSERT ON `affiliateos`.`audit_logs`
--      TO 'affiliateos_app'@'127.0.0.1';
--
--    (repeat the two blocks for @'localhost' if that host form is kept)
-- ---------------------------------------------------------------------------

FLUSH PRIVILEGES;

-- ---------------------------------------------------------------------------
-- 4. Verification (paste the output back for the checkpoint record)
-- ---------------------------------------------------------------------------
SHOW GRANTS FOR 'affiliateos_app'@'127.0.0.1';
SHOW GRANTS FOR 'affiliateos_migrate'@'127.0.0.1';
