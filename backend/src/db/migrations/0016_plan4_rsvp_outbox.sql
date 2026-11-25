CREATE TABLE `session_rsvp` (
	`session_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`status` enum('going','not_going') NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `session_rsvp_session_id_user_id_pk` PRIMARY KEY(`session_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `telegram_outbox` ADD `time_zone` varchar(64);--> statement-breakpoint
ALTER TABLE `session_rsvp` ADD CONSTRAINT `session_rsvp_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `session_rsvp` ADD CONSTRAINT `session_rsvp_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `session_rsvp_user_id_idx` ON `session_rsvp` (`user_id`);--> statement-breakpoint
CREATE INDEX `telegram_outbox_status_id_idx` ON `telegram_outbox` (`status`,`id`);