CREATE TABLE `moderation_digest_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`digest_date` char(10) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `moderation_digest_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `moderation_digest_log_user_date_uq` UNIQUE(`user_id`,`digest_date`)
);
--> statement-breakpoint
ALTER TABLE `notifications` MODIFY COLUMN `category` enum('applications','members','sessions','reminders','games','ratings','moderation') NOT NULL;--> statement-breakpoint
ALTER TABLE `moderation_digest_log` ADD CONSTRAINT `moderation_digest_log_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;