-- AffiliateOS Phase 2 — workspace office settings.
--
-- Scope: ONLY the four columns the Phase 2 office-settings endpoint needs. The
-- other 26 future-phase models already declared in schema.prisma remain unmigrated
-- on purpose; this migration must not bring them in.
--
-- Applies on top of `20261117000000_m1_foundation_13_tables`. Existing workspace
-- rows receive the defaults, so no backfill statement is required.
--
-- Rollback (Phase 2 only, loses office data):
--   ALTER TABLE `workspaces`
--     DROP COLUMN `work_end`,
--     DROP COLUMN `work_start`,
--     DROP COLUMN `timezone`,
--     DROP COLUMN `address`;

ALTER TABLE `workspaces`
    ADD COLUMN `address` VARCHAR(255) NULL,
    ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
    ADD COLUMN `work_start` CHAR(5) NOT NULL DEFAULT '09:00',
    ADD COLUMN `work_end` CHAR(5) NOT NULL DEFAULT '17:00';
