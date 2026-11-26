CREATE TABLE `calendar_reminders` (
	`user_id` bigint unsigned NOT NULL,
	`game_id` bigint unsigned,
	`sent_at` datetime(3) NOT NULL,
	CONSTRAINT `calendar_reminders_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `rsvp_decline_notices` (
	`session_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`declined_at` datetime(3) NOT NULL,
	`notified_at` datetime(3),
	CONSTRAINT `rsvp_decline_notices_session_id_user_id_pk` PRIMARY KEY(`session_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `calendar_reminders` ADD CONSTRAINT `calendar_reminders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rsvp_decline_notices` ADD CONSTRAINT `rsvp_decline_notices_session_id_game_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rsvp_decline_notices` ADD CONSTRAINT `rsvp_decline_notices_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `rsvp_decline_notices_declined_at_idx` ON `rsvp_decline_notices` (`declined_at`);