CREATE TABLE `calendar_feeds` (
	`user_id` bigint unsigned NOT NULL,
	`token_hash` char(64) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`last_access_at` datetime(3),
	CONSTRAINT `calendar_feeds_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `calendar_feeds_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `calendar_feeds` ADD CONSTRAINT `calendar_feeds_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;