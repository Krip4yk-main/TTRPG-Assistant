CREATE TABLE `poll_options` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`poll_id` bigint unsigned NOT NULL,
	`position` tinyint NOT NULL,
	`weekday` tinyint,
	`start_min` smallint,
	`starts_at` datetime NOT NULL,
	CONSTRAINT `poll_options_id` PRIMARY KEY(`id`),
	CONSTRAINT `poll_options_poll_id_position_uq` UNIQUE(`poll_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`option_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`poll_id` bigint unsigned NOT NULL,
	`value` enum('yes','no','maybe') NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `poll_votes_option_id_user_id_pk` PRIMARY KEY(`option_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `polls` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`game_id` bigint unsigned NOT NULL,
	`kind` enum('regular','one_off') NOT NULL,
	`status` enum('open','closed') NOT NULL DEFAULT 'open',
	`close_reason` enum('all_voted','deadline','gm'),
	`session_id` bigint unsigned,
	`duration_minutes` smallint NOT NULL,
	`closes_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`closed_at` datetime(3),
	`applied_at` datetime(3),
	`applied_option_id` bigint unsigned,
	`applied_session_id` bigint unsigned,
	CONSTRAINT `polls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `notifications` MODIFY COLUMN `category` enum('applications','members','sessions','reminders','games','ratings','moderation','schedule') NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `site` json;--> statement-breakpoint
ALTER TABLE `poll_options` ADD CONSTRAINT `poll_options_poll_id_polls_id_fk` FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `poll_votes` ADD CONSTRAINT `poll_votes_option_id_poll_options_id_fk` FOREIGN KEY (`option_id`) REFERENCES `poll_options`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `poll_votes` ADD CONSTRAINT `poll_votes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `poll_votes` ADD CONSTRAINT `poll_votes_poll_id_polls_id_fk` FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `polls` ADD CONSTRAINT `polls_game_id_games_id_fk` FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `polls` ADD CONSTRAINT `polls_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `poll_votes_poll_id_user_id_idx` ON `poll_votes` (`poll_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `poll_votes_user_id_idx` ON `poll_votes` (`user_id`);--> statement-breakpoint
CREATE INDEX `polls_game_id_status_idx` ON `polls` (`game_id`,`status`);--> statement-breakpoint
CREATE INDEX `polls_status_closes_at_idx` ON `polls` (`status`,`closes_at`);