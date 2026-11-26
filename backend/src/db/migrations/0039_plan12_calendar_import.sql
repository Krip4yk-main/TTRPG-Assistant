CREATE TABLE `calendar_import_busy` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3) NOT NULL,
	CONSTRAINT `calendar_import_busy_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `calendar_imports` (
	`user_id` bigint unsigned NOT NULL,
	`url_enc` varchar(4096) NOT NULL,
	`host` varchar(255) NOT NULL,
	`last_sync_at` datetime(3),
	`last_attempt_at` datetime(3),
	`last_error` varchar(32),
	`failures` int NOT NULL DEFAULT 0,
	`broken_at` datetime(3),
	`events_count` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `calendar_imports_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
ALTER TABLE `calendar_import_busy` ADD CONSTRAINT `calendar_import_busy_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_imports` ADD CONSTRAINT `calendar_imports_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `calendar_import_busy_user_starts_idx` ON `calendar_import_busy` (`user_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `calendar_imports_last_attempt_idx` ON `calendar_imports` (`broken_at`,`last_attempt_at`);