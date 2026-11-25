CREATE TABLE `entity_views` (
	`user_id` bigint unsigned NOT NULL,
	`entity_type` enum('game','application','session') NOT NULL,
	`entity_id` bigint unsigned NOT NULL,
	`viewed_at` datetime(3) NOT NULL,
	CONSTRAINT `entity_views_user_id_entity_type_entity_id_pk` PRIMARY KEY(`user_id`,`entity_type`,`entity_id`)
);
--> statement-breakpoint
ALTER TABLE `games` MODIFY COLUMN `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);--> statement-breakpoint
ALTER TABLE `game_applications` ADD `updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) NOT NULL;--> statement-breakpoint
ALTER TABLE `game_sessions` ADD `updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_views` ADD CONSTRAINT `entity_views_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE `game_applications` SET `updated_at` = COALESCE(`decided_at`, `created_at`);--> statement-breakpoint
UPDATE `game_sessions` SET `updated_at` = COALESCE(`done_at`, `created_at`);--> statement-breakpoint
INSERT INTO `entity_views` (`user_id`, `entity_type`, `entity_id`, `viewed_at`) SELECT `gm_user_id`, 'game', `id`, CURRENT_TIMESTAMP(3) FROM `games`;--> statement-breakpoint
INSERT INTO `entity_views` (`user_id`, `entity_type`, `entity_id`, `viewed_at`) SELECT `user_id`, 'application', `id`, CURRENT_TIMESTAMP(3) FROM `game_applications`;
