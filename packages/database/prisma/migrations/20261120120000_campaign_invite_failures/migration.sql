-- Track manually reported affiliate invitation failures and retry attempts.
-- Additive: extends the existing status enum and adds nullable/detail fields.
ALTER TABLE `campaign_creators`
  MODIFY `status` ENUM('INVITED','INVITE_FAILED','ACCEPTED','DECLINED','ACTIVE','COMPLETED','REMOVED') NOT NULL DEFAULT 'INVITED',
  ADD COLUMN `invite_attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `invite_error` VARCHAR(255) NULL;
