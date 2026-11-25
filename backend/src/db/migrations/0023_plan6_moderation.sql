CREATE TABLE `complaints` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`reporter_id` bigint unsigned NOT NULL,
	`target_user_id` bigint unsigned,
	`target_game_id` bigint unsigned,
	`reason` enum('scam','harassment','no_show','agreement_violation','inappropriate_content','other') NOT NULL,
	`message` varchar(2000) NOT NULL DEFAULT '',
	`status` enum('new','dismissed','actioned') NOT NULL DEFAULT 'new',
	`resolved_by` bigint unsigned,
	`resolved_at` datetime(3),
	`sanction_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `complaints_id` PRIMARY KEY(`id`),
	CONSTRAINT `complaints_one_target_ck` CHECK((`complaints`.`target_user_id` IS NULL) <> (`complaints`.`target_game_id` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `moderation_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`actor_id` bigint unsigned,
	`action` varchar(64) NOT NULL,
	`target_type` varchar(32) NOT NULL,
	`target_id` bigint unsigned NOT NULL,
	`reason` varchar(2000),
	`meta` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `moderation_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sanction_appeals` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`sanction_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`message` varchar(2000) NOT NULL,
	`status` enum('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
	`decided_by` bigint unsigned,
	`decided_at` datetime(3),
	`decision_note` varchar(2000),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sanction_appeals_id` PRIMARY KEY(`id`),
	CONSTRAINT `sanction_appeals_sanction_id_uq` UNIQUE(`sanction_id`)
);
--> statement-breakpoint
CREATE TABLE `sanctions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`type` enum('warning','application_limit','no_paid_apply','no_paid_create','global_ban') NOT NULL,
	`reason` varchar(2000) NOT NULL,
	`imposed_by` bigint unsigned,
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3),
	`lifted_at` datetime(3),
	`lifted_by` bigint unsigned,
	`complaint_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sanctions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `identity_tombstones` ADD `user_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `ratings` ADD `moderated` enum('none','text_hidden','cancelled') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `ratings` ADD `moderated_by` bigint unsigned;--> statement-breakpoint
ALTER TABLE `ratings` ADD `moderated_at` datetime(3);--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_reporter_id_users_id_fk` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_target_user_id_users_id_fk` FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_target_game_id_games_id_fk` FOREIGN KEY (`target_game_id`) REFERENCES `games`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_resolved_by_users_id_fk` FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_sanction_id_sanctions_id_fk` FOREIGN KEY (`sanction_id`) REFERENCES `sanctions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `moderation_log` ADD CONSTRAINT `moderation_log_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sanction_appeals` ADD CONSTRAINT `sanction_appeals_sanction_id_sanctions_id_fk` FOREIGN KEY (`sanction_id`) REFERENCES `sanctions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sanction_appeals` ADD CONSTRAINT `sanction_appeals_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sanction_appeals` ADD CONSTRAINT `sanction_appeals_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sanctions` ADD CONSTRAINT `sanctions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sanctions` ADD CONSTRAINT `sanctions_imposed_by_users_id_fk` FOREIGN KEY (`imposed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sanctions` ADD CONSTRAINT `sanctions_lifted_by_users_id_fk` FOREIGN KEY (`lifted_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sanctions` ADD CONSTRAINT `sanctions_complaint_id_complaints_id_fk` FOREIGN KEY (`complaint_id`) REFERENCES `complaints`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `complaints_status_id_idx` ON `complaints` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `complaints_target_user_id_idx` ON `complaints` (`target_user_id`);--> statement-breakpoint
CREATE INDEX `complaints_target_game_id_idx` ON `complaints` (`target_game_id`);--> statement-breakpoint
CREATE INDEX `moderation_log_target_idx` ON `moderation_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `moderation_log_actor_id_idx` ON `moderation_log` (`actor_id`);--> statement-breakpoint
CREATE INDEX `sanction_appeals_status_id_idx` ON `sanction_appeals` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `sanctions_user_type_ends_idx` ON `sanctions` (`user_id`,`type`,`ends_at`);--> statement-breakpoint
ALTER TABLE `identity_tombstones` ADD CONSTRAINT `identity_tombstones_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_moderated_by_users_id_fk` FOREIGN KEY (`moderated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `identity_tombstones_user_id_idx` ON `identity_tombstones` (`user_id`);--> statement-breakpoint
-- Перенесення банів і `ban_appeals` (дані). Порядок важливий: таблиця `sanctions` щойно створена
-- й порожня, тож санкції для апеляцій на минулі бани (не на поточний) беруть явний id = id
-- апеляції (зв'язок 1:1 без тимчасових колонок); поточні бани далі отримують id з AUTO_INCREMENT.
-- Минулий бан уже знятий (`lifted_at`), а його апеляцію позначено прийнятою (бан скасовано).
-- `imposed_by`/`lifted_by`/`decided_by` NULL — система.
INSERT INTO `sanctions` (`id`, `user_id`, `type`, `reason`, `imposed_by`, `starts_at`, `ends_at`, `lifted_at`, `lifted_by`, `created_at`)
SELECT ba.`id`, ba.`user_id`, 'global_ban', 'Бан, накладений до запуску модерації.', NULL, ba.`created_at`, NULL, CURRENT_TIMESTAMP(3), NULL, CURRENT_TIMESTAMP(3)
FROM `ban_appeals` ba INNER JOIN `users` u ON u.`id` = ba.`user_id`
WHERE NOT (u.`is_banned` = 1 AND ba.`ban_epoch` = u.`ban_epoch`);--> statement-breakpoint
-- Кожен поточний бан (зокрема без апеляції) — чинна безстрокова санкція `global_ban`.
INSERT INTO `sanctions` (`user_id`, `type`, `reason`, `imposed_by`, `starts_at`, `ends_at`, `created_at`)
SELECT u.`id`, 'global_ban', 'Бан, накладений до запуску модерації.', NULL,
  COALESCE((SELECT ba.`created_at` FROM `ban_appeals` ba WHERE ba.`user_id` = u.`id` AND ba.`ban_epoch` = u.`ban_epoch`), CURRENT_TIMESTAMP(3)),
  NULL, CURRENT_TIMESTAMP(3)
FROM `users` u WHERE u.`is_banned` = 1;--> statement-breakpoint
-- Апеляції на поточний бан — нерозглянуті, на чинній санкції.
INSERT INTO `sanction_appeals` (`sanction_id`, `user_id`, `message`, `status`, `created_at`)
SELECT s.`id`, ba.`user_id`, LEFT(ba.`message`, 2000), 'pending', ba.`created_at`
FROM `ban_appeals` ba
INNER JOIN `users` u ON u.`id` = ba.`user_id` AND u.`is_banned` = 1 AND ba.`ban_epoch` = u.`ban_epoch`
INNER JOIN `sanctions` s ON s.`user_id` = u.`id` AND s.`type` = 'global_ban' AND s.`lifted_at` IS NULL;--> statement-breakpoint
-- Апеляції на минулі бани — прийняті, на знятій санкції з тим самим id.
INSERT INTO `sanction_appeals` (`sanction_id`, `user_id`, `message`, `status`, `decided_at`, `created_at`)
SELECT ba.`id`, ba.`user_id`, LEFT(ba.`message`, 2000), 'accepted', CURRENT_TIMESTAMP(3), ba.`created_at`
FROM `ban_appeals` ba INNER JOIN `users` u ON u.`id` = ba.`user_id`
WHERE NOT (u.`is_banned` = 1 AND ba.`ban_epoch` = u.`ban_epoch`);
