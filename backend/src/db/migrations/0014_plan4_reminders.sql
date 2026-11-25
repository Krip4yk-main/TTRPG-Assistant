CREATE TABLE `reminder_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`session_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`offset_min` smallint NOT NULL,
	`starts_at` datetime(3) NOT NULL,
	`sent_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reminder_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `reminder_log_session_user_offset_starts_uq` UNIQUE(`session_id`,`user_id`,`offset_min`,`starts_at`)
);
--> statement-breakpoint
ALTER TABLE `reminder_log` ADD CONSTRAINT `reminder_log_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reminder_log` ADD CONSTRAINT `reminder_log_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `reminder_log_user_id_idx` ON `reminder_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `reminder_log_sent_at_idx` ON `reminder_log` (`sent_at`);