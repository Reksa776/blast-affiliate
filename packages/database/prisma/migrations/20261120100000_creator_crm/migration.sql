-- Creator CRM tables. Additive migration; TikTok integration is not required.
CREATE TABLE `creators` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `tiktok_creator_id` VARCHAR(64) NULL,
  `username` VARCHAR(96) NOT NULL,
  `display_name` VARCHAR(160) NOT NULL,
  `avatar_url` VARCHAR(512) NULL,
  `follower_count` INTEGER UNSIGNED NULL,
  `status` ENUM('NEW','CONTACTED','INVITED','ACCEPTED','COLLABORATING','COMPLETED','REJECTED','UNRESPONSIVE','BLACKLISTED') NOT NULL DEFAULT 'NEW',
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `creators_tenant_id_tiktok_creator_id_key` (`tenant_id`,`tiktok_creator_id`),
  UNIQUE INDEX `creators_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `creators_tenant_id_status_created_at_idx` (`tenant_id`,`status`,`created_at`),
  UNIQUE INDEX `creators_tenant_id_username_key` (`tenant_id`,`username`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_profiles` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `bio` TEXT NULL,
  `region` CHAR(2) NULL,
  `language` VARCHAR(16) NULL,
  `metrics` JSON NULL,
  `metrics_captured_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `creator_profiles_tenant_id_creator_id_key` (`tenant_id`,`creator_id`),
  UNIQUE INDEX `creator_profiles_tenant_id_id_key` (`tenant_id`,`id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_assignments` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `member_id` CHAR(36) NOT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `unassigned_at` DATETIME(3) NULL,
  `assigned_by_member_id` CHAR(36) NULL,
  UNIQUE INDEX `creator_assignments_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `creator_assignments_tenant_id_member_id_is_active_idx` (`tenant_id`,`member_id`,`is_active`),
  INDEX `creator_assignments_tenant_id_creator_id_is_active_idx` (`tenant_id`,`creator_id`,`is_active`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_activities` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `type` ENUM('NOTE','CALL','EMAIL','WHATSAPP','MEETING','STATUS_CHANGE','ASSIGNMENT','OTHER') NOT NULL,
  `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `summary` VARCHAR(255) NOT NULL,
  `metadata` JSON NULL,
  `actor_member_id` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `creator_activities_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `creator_activities_tenant_id_creator_id_occurred_at_idx` (`tenant_id`,`creator_id`,`occurred_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_status_histories` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `from_status` ENUM('NEW','CONTACTED','INVITED','ACCEPTED','COLLABORATING','COMPLETED','REJECTED','UNRESPONSIVE','BLACKLISTED') NULL,
  `to_status` ENUM('NEW','CONTACTED','INVITED','ACCEPTED','COLLABORATING','COMPLETED','REJECTED','UNRESPONSIVE','BLACKLISTED') NOT NULL,
  `reason` VARCHAR(255) NULL,
  `changed_by_member_id` CHAR(36) NULL,
  `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `creator_status_histories_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `creator_status_histories_tenant_id_creator_id_changed_at_idx` (`tenant_id`,`creator_id`,`changed_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_tags` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `label` VARCHAR(64) NOT NULL,
  `color` VARCHAR(16) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `creator_tags_tenant_id_label_key` (`tenant_id`,`label`),
  UNIQUE INDEX `creator_tags_tenant_id_id_key` (`tenant_id`,`id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_tag_assignments` (
  `tenant_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `tag_id` CHAR(36) NOT NULL,
  `assigned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `creator_tag_assignments_tenant_id_tag_id_idx` (`tenant_id`,`tag_id`),
  PRIMARY KEY (`tenant_id`,`creator_id`,`tag_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_notes` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `author_member_id` CHAR(36) NULL,
  `body` TEXT NOT NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `creator_notes_tenant_id_id_key` (`tenant_id`,`id`),
  INDEX `creator_notes_tenant_id_creator_id_created_at_idx` (`tenant_id`,`creator_id`,`created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `creator_blacklists` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `creator_id` CHAR(36) NOT NULL,
  `reason` VARCHAR(255) NOT NULL,
  `scope` VARCHAR(64) NULL,
  `created_by_member_id` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `revoked_at` DATETIME(3) NULL,
  UNIQUE INDEX `creator_blacklists_tenant_id_creator_id_key` (`tenant_id`,`creator_id`),
  UNIQUE INDEX `creator_blacklists_tenant_id_id_key` (`tenant_id`,`id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `creators` ADD CONSTRAINT `creators_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_profiles` ADD CONSTRAINT `creator_profiles_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_profiles` ADD CONSTRAINT `creator_profiles_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_assignments` ADD CONSTRAINT `creator_assignments_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_assignments` ADD CONSTRAINT `creator_assignments_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_assignments` ADD CONSTRAINT `creator_assignments_tenant_id_member_id_fkey` FOREIGN KEY (`tenant_id`,`member_id`) REFERENCES `workspace_members`(`tenant_id`,`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `creator_activities` ADD CONSTRAINT `creator_activities_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_activities` ADD CONSTRAINT `creator_activities_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_status_histories` ADD CONSTRAINT `creator_status_histories_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_status_histories` ADD CONSTRAINT `creator_status_histories_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_tags` ADD CONSTRAINT `creator_tags_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_tag_assignments` ADD CONSTRAINT `creator_tag_assignments_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_tag_assignments` ADD CONSTRAINT `creator_tag_assignments_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_tag_assignments` ADD CONSTRAINT `creator_tag_assignments_tenant_id_tag_id_fkey` FOREIGN KEY (`tenant_id`,`tag_id`) REFERENCES `creator_tags`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_notes` ADD CONSTRAINT `creator_notes_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_notes` ADD CONSTRAINT `creator_notes_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_blacklists` ADD CONSTRAINT `creator_blacklists_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `creator_blacklists` ADD CONSTRAINT `creator_blacklists_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`,`creator_id`) REFERENCES `creators`(`tenant_id`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
