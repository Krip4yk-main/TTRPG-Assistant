CREATE TABLE `notification_prefs` (
	`user_id` bigint unsigned NOT NULL,
	`telegram` json NOT NULL,
	`reminder_offsets` json NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `notification_prefs_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`event_id` bigint unsigned,
	`user_id` bigint unsigned NOT NULL,
	`type` varchar(64) NOT NULL,
	`category` enum('applications','members','sessions','reminders','games') NOT NULL,
	`payload` json NOT NULL,
	`entity_type` varchar(32),
	`entity_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`read_at` datetime(3),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `notifications_event_id_user_id_uq` UNIQUE(`event_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `events` ADD `dispatched_at` datetime(3);--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD CONSTRAINT `notification_prefs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `notifications_user_id_id_idx` ON `notifications` (`user_id`,`id` desc);--> statement-breakpoint
CREATE INDEX `notifications_user_id_read_at_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `events_dispatched_at_id_idx` ON `events` (`dispatched_at`,`id`);--> statement-breakpoint
-- Історію не сповіщаємо: усі події до цієї міграції вважаються вже обробленими.
UPDATE `events` SET `dispatched_at` = CURRENT_TIMESTAMP(3) WHERE `dispatched_at` IS NULL;
