-- Local AffiliateOS runtime grants for the Creator CRM and campaign tables.
--
-- Apply only as a MariaDB administrator or account with GRANT OPTION after the
-- matching migrations are present. Targets the existing runtime account
-- affiliateos_app@localhost; does not create users or change passwords.
--
-- Ten tables receive CRUD. Four history/brief tables remain append-only from the
-- application's perspective and receive SELECT, INSERT only.

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
