-- Local campaign planning. `shop_name` stays free text until a TikTok shop is linked.
CREATE TABLE `campaigns` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `shop_name` VARCHAR(160) NULL,
  `name` VARCHAR(160) NOT NULL,
  `status` ENUM('DRAFT','SCHEDULED','ACTIVE','PAUSED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  `starts_at` DATETIME(3) NOT NULL,
  `ends_at` DATETIME(3) NULL,
  `budget` DECIMAL(18,2) NULL,
  `currency` CHAR(3) NOT NULL DEFAULT 'IDR',
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `campaigns_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `campaigns_tenant_id_status_starts_at_idx` (`tenant_id`,`status`,`starts_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `campaign_creators` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `campaign_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `status` ENUM('INVITED','ACCEPTED','DECLINED','ACTIVE','COMPLETED','REMOVED') NOT NULL DEFAULT 'INVITED',
  `invited_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `responded_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `campaign_creators_tenant_id_campaign_id_creator_id_key` (`tenant_id`,`campaign_id`,`creator_id`),
  UNIQUE INDEX `campaign_creators_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `campaign_creators_tenant_id_creator_id_status_idx` (`tenant_id`,`creator_id`,`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `campaign_contents` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `campaign_id` CHAR(36) NOT NULL,
  `kind` ENUM('BRIEF','SCRIPT','ASSET_LINK') NOT NULL DEFAULT 'BRIEF',
  `version` INTEGER UNSIGNED NOT NULL,
  `title` VARCHAR(160) NOT NULL,
  `body` TEXT NOT NULL,
  `created_by_member_id` CHAR(36) NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `campaign_contents_tenant_id_campaign_id_kind_version_key` (`tenant_id`,`campaign_id`,`kind`,`version`),
  UNIQUE INDEX `campaign_contents_tenant_id_id_key` (`tenant_id`,`id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `campaign_ad_codes` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `campaign_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `campaign_ad_codes_tenant_id_campaign_id_creator_id_code_key` (`tenant_id`,`campaign_id`,`creator_id`,`code`),
  UNIQUE INDEX `campaign_ad_codes_tenant_id_id_key` (`tenant_id`,`id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `campaign_status_histories` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `campaign_id` CHAR(36) NOT NULL,
  `from_status` ENUM('DRAFT','SCHEDULED','ACTIVE','PAUSED','COMPLETED','CANCELLED') NULL,
  `to_status` ENUM('DRAFT','SCHEDULED','ACTIVE','PAUSED','COMPLETED','CANCELLED') NOT NULL,
  `reason` VARCHAR(255) NULL,
  `changed_by_member_id` CHAR(36) NULL,
  `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `campaign_status_histories_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `campaign_status_histories_tenant_id_campaign_id_changed_at_idx` (`tenant_id`,`campaign_id`,`changed_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_creators` ADD CONSTRAINT `campaign_creators_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_creators` ADD CONSTRAINT `campaign_creators_tenant_id_campaign_id_fkey` FOREIGN KEY (`tenant_id`,`campaign_id`) REFERENCES `campaigns`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_creators` ADD CONSTRAINT `campaign_creators_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `campaign_contents` ADD CONSTRAINT `campaign_contents_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_contents` ADD CONSTRAINT `campaign_contents_tenant_id_campaign_id_fkey` FOREIGN KEY (`tenant_id`,`campaign_id`) REFERENCES `campaigns`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_ad_codes` ADD CONSTRAINT `campaign_ad_codes_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_ad_codes` ADD CONSTRAINT `campaign_ad_codes_tenant_id_campaign_id_fkey` FOREIGN KEY (`tenant_id`,`campaign_id`) REFERENCES `campaigns`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_ad_codes` ADD CONSTRAINT `campaign_ad_codes_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `campaign_status_histories` ADD CONSTRAINT `campaign_status_histories_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `campaign_status_histories` ADD CONSTRAINT `campaign_status_histories_tenant_id_campaign_id_fkey` FOREIGN KEY (`tenant_id`,`campaign_id`) REFERENCES `campaigns`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
