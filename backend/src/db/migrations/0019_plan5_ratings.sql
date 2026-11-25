CREATE TABLE `published_ratings` (
	`user_id` bigint unsigned NOT NULL,
	`role` enum('gm','player_from_gm','player_from_player') NOT NULL,
	`overall` decimal(3,2),
	`overall_units` int NOT NULL DEFAULT 0,
	`criteria` json,
	`units` int NOT NULL DEFAULT 0,
	`last_rating_id` bigint unsigned,
	`published_at` datetime(3),
	CONSTRAINT `published_ratings_user_role_pk` PRIMARY KEY(`user_id`,`role`)
);
--> statement-breakpoint
CREATE TABLE `rating_reminder_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`session_id` bigint unsigned,
	`slot_key` bigint unsigned GENERATED ALWAYS AS (COALESCE(session_id, 0)) VIRTUAL,
	`kind` enum('deadline') NOT NULL,
	`sent_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `rating_reminder_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `rating_reminder_log_user_game_slot_kind_uq` UNIQUE(`user_id`,`game_id`,`slot_key`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `ratings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`rater_id` bigint unsigned NOT NULL,
	`ratee_id` bigint unsigned NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`session_id` bigint unsigned,
	`slot_key` bigint unsigned GENERATED ALWAYS AS (COALESCE(session_id, 0)) VIRTUAL,
	`kind` enum('session','final') NOT NULL,
	`role` enum('gm','player_from_gm','player_from_player') NOT NULL,
	`declined` boolean NOT NULL DEFAULT false,
	`overall` tinyint unsigned,
	`criteria` json,
	`comment` varchar(2000),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ratings_id` PRIMARY KEY(`id`),
	CONSTRAINT `ratings_rater_ratee_game_slot_uq` UNIQUE(`rater_id`,`ratee_id`,`game_id`,`slot_key`)
);
--> statement-breakpoint
ALTER TABLE `published_ratings` ADD CONSTRAINT `published_ratings_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rating_reminder_log` ADD CONSTRAINT `rating_reminder_log_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rating_reminder_log` ADD CONSTRAINT `rating_reminder_log_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rating_reminder_log` ADD CONSTRAINT `rating_reminder_log_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_rater_id_users_id_fk` FOREIGN KEY (`rater_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_ratee_id_users_id_fk` FOREIGN KEY (`ratee_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ratings` ADD CONSTRAINT `ratings_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `published_ratings_role_overall_idx` ON `published_ratings` (`role`,`overall`);--> statement-breakpoint
CREATE INDEX `rating_reminder_log_game_id_idx` ON `rating_reminder_log` (`game_id`);--> statement-breakpoint
CREATE INDEX `ratings_ratee_role_id_idx` ON `ratings` (`ratee_id`,`role`,`id`);--> statement-breakpoint
CREATE INDEX `ratings_game_id_idx` ON `ratings` (`game_id`);